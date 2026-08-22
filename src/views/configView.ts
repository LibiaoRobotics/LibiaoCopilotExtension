import * as vscode from "vscode";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId, getBuiltInModels } from "../utils";
import { fetchModels, clearModelListCache } from "../provideModel";
import { ensureModelContextDefaults } from "../modelConfiguration";
import { VersionManager } from "../versionManager";
import { loadTestModelList, runModelTests, type ModelTestResult } from "../modelTester";

interface InitPayload {
	baseUrl: string;
	apiKey: string;
	delay: number;
	readFileLines: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitModel: string;
	commitModels: HFModelItem[];
	commitLanguage: string;
	visionIcon: string;
	contextManagement: string;
	summarizationInstructions: string;
	summarizeMaxTokens: number;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	modelTestEnabled: boolean;
}

interface ExportConfig {
	version: string;
	exportDate: string;
	baseUrl: string;
	apiKey: string;
	delay: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitLanguage: string;
	commitModel: string;
	visionIcon: string;
	contextManagement: string;
	summarizationInstructions: string;
	summarizeMaxTokens: number;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	readFileLines: number;
}

type IncomingMessage =
	| { type: "requestInit" }
	| {
			type: "saveGlobalConfig";
			baseUrl: string;
			apiKey: string;
			delay: number;
			readFileLines: number;
			retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] };
			commitModel: string;
			visionIcon: string;
			commitLanguage: string;
			contextManagement: string;
			summarizationInstructions: string;
			summarizeMaxTokens: number;
	  }
	| {
			type: "fetchModels";
			baseUrl: string;
			apiKey: string;
			apiMode?: HFApiMode | string;
			headers?: Record<string, string>;
	  }
	| { type: "addModel"; model: HFModelItem }
	| { type: "updateModel"; model: HFModelItem; originalModelId?: string; originalConfigId?: string }
	| { type: "deleteModel"; modelId: string }
	| { type: "requestConfirm"; id: string; message: string; action: string }
	| { type: "exportConfig" }
	| { type: "importConfig" }
	| { type: "openSettings" }
	| { type: "resetModels" }
	| { type: "fetchTestModels" }
	| { type: "updateModelTestExclude"; exclude: string[] }
	| { type: "testSelectedModels"; modelIds: string[] }
	| { type: "cancelModelTest" };

type OutgoingMessage =
	| { type: "init"; payload: InitPayload }
	| { type: "modelsFetched"; models: HFModelItem[] }
	| { type: "modelTestListLoaded"; modelIds: string[]; exclude: string[] }
	| { type: "modelTestListError"; error: string }
	| { type: "confirmResponse"; id: string; confirmed: boolean }
	| { type: "modelTestStarted"; modelIds: string[] }
	| { type: "modelTestRowRunning"; modelId: string }
	| {
			type: "modelTestResult";
			result: ModelTestResult;
			done: number;
			total: number;
	  }
	| { type: "modelTestDone"; tested: number; succeeded: number; total: number }
	| { type: "modelTestStatus"; testing: boolean };

export class ConfigViewPanel {
	public static currentPanel: ConfigViewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly secrets: vscode.SecretStorage;
	private disposables: vscode.Disposable[] = [];
	// 模型测试会话状态（面板级，防止面板重建后状态泄漏）
	private modelTestRunning = false;
	private modelTestCancelToken: vscode.CancellationTokenSource | undefined;

	public static openPanel(extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (ConfigViewPanel.currentPanel) {
			ConfigViewPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"libiaoCopilot.config",
			"Libiao Copilot 配置",
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "assets")],
			}
		);

		ConfigViewPanel.currentPanel = new ConfigViewPanel(panel, extensionUri, secrets);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.secrets = secrets;

		this.update();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				this.handleMessage(message).catch((err) => {
					console.error("[libiaoCopilot] handleMessage failed", err);
					vscode.window.showErrorMessage(
						err instanceof Error
							? err.message
							: `处理配置消息时发生意外错误[${message.type}]。`
					);
				});
			},
			null,
			this.disposables
		);

		// Send initialization data
		this.sendInit();
	}

	private async update() {
		const webview = this.panel.webview;
		this.panel.webview.html = await this.getHtml(webview);
	}

	public dispose() {
		ConfigViewPanel.currentPanel = undefined;

		// 面板关闭时取消正在运行的模型测试，避免测试在后台继续消耗 token
		if (this.modelTestRunning && this.modelTestCancelToken) {
			this.modelTestCancelToken.cancel();
		}
		this.modelTestCancelToken?.dispose();
		this.modelTestCancelToken = undefined;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	async handleMessage(message: IncomingMessage) {
		switch (message.type) {
			case "requestInit":
				await this.sendInit();
				break;
			case "saveGlobalConfig":
				await this.saveGlobalConfig(
					message.baseUrl,
					message.apiKey,
					message.delay,
					message.readFileLines,
					message.retry,
					message.commitModel,
					message.commitLanguage,
					message.visionIcon,
					message.contextManagement,
					message.summarizationInstructions,
					message.summarizeMaxTokens
				);
				break;
			case "fetchModels": {
				try {
					const { models } = await fetchModels(message.baseUrl, message.apiKey, message.apiMode, message.headers);
					this.panel.webview.postMessage({ type: "modelsFetched", models });
				} catch (err) {
					console.error("[libiaoCopilot] fetchModels failed", err);
					const errorMessage = err instanceof Error ? err.message : String(err);
					this.panel.webview.postMessage({ type: "modelsFetchError", error: errorMessage });
				}
				break;
			}
			case "addModel":
				await this.addModel(message.model);
				break;
			case "updateModel":
				await this.updateModel(message.model, message.originalModelId, message.originalConfigId);
				break;
			case "requestConfirm":
				await this.handleConfirmRequest(message.id, message.message, message.action);
				break;
			case "deleteModel":
				await this.deleteModel(message.modelId);
				break;
			case "exportConfig":
				await this.exportConfig();
				break;
			case "importConfig":
				await this.importConfig();
				break;
			case "resetModels":
				await this.resetModelList();
				break;
			case "openSettings":
				await this.openSettings();
				break;
			case "fetchTestModels":
				await this.fetchTestModelList();
				break;
			case "updateModelTestExclude":
				await this.updateModelTestExclude(message.exclude);
				break;
			case "testSelectedModels":
				await this.testSelectedModels(message.modelIds);
				break;
			case "cancelModelTest":
				this.cancelModelTests();
				break;
			default:
				break;
		}
	}

	private async openSettings() {
		// Open the user settings.json where libiaoCopilot.* options live
		await vscode.commands.executeCommand("workbench.action.openSettingsJson");
	}

	/**
	 * 前端查询测试状态（init 后补充同步，防面板重建后状态丢失）
	 */
	private sendTestStatus() {
		this.panel.webview.postMessage({ type: "modelTestStatus", testing: this.modelTestRunning } as OutgoingMessage);
	}

	/**
	 * 加载测试模型列表（不启动测试）：走合并验证，把全部待测模型 + 黑名单发给前端，
	 * 由用户在表格里勾选后再显式发起测试。
	 */
	private async fetchTestModelList() {
		try {
			const { modelIds, reason } = await loadTestModelList(this.secrets);
			const exclude = this.readModelTestExclude();
			if (modelIds.length === 0) {
				this.panel.webview.postMessage({
					type: "modelTestListLoaded",
					modelIds: [],
					exclude: [],
				} as OutgoingMessage);
				if (reason) {
					this.panel.webview.postMessage({ type: "modelTestListError", error: reason } as OutgoingMessage);
				}
				return;
			}
			this.panel.webview.postMessage({
				type: "modelTestListLoaded",
				modelIds,
				exclude,
			} as OutgoingMessage);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.panel.webview.postMessage({ type: "modelTestListError", error: errorMessage } as OutgoingMessage);
		}
	}

	/** 读取模型测试黑名单（隐藏参数，默认空数组） */
	private readModelTestExclude(): string[] {
		const config = vscode.workspace.getConfiguration();
		const value = config.get<unknown>("libiaoCopilot.modelTestExclude", []);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	}

	/**
	 * 整表覆盖写入模型测试黑名单（保存/导出/导入均不触碰该参数）。
	 * 写入前做类型校验 + 去重，防止前端发垃圾污染 settings。
	 */
	private async updateModelTestExclude(exclude: string[]) {
		if (!Array.isArray(exclude)) {
			return;
		}
		const cleaned = [...new Set(exclude.filter((v): v is string => typeof v === "string" && v.length > 0))];
		const config = vscode.workspace.getConfiguration();
		await config.update("libiaoCopilot.modelTestExclude", cleaned, vscode.ConfigurationTarget.Global);
	}

	/**
	 * 一键测试：对勾选的模型并发实测 TPS 并验证可用性（点击后立即展示全部待测模型）。
	 * 开关（libiaoCopilot.modelTestEnabled，默认 false）由 settings.json 控制，
	 * 保存/导出/导入配置均不触碰该参数（保持隐藏不迁移）。
	 */
	private async testSelectedModels(modelIds: string[]) {
		if (this.modelTestRunning) {
			return;
		}
		const config = vscode.workspace.getConfiguration();
		const enabled = config.get<boolean>("libiaoCopilot.modelTestEnabled", false);
		if (!enabled) {
			this.panel.webview.postMessage({ type: "modelTestStatus", testing: false } as OutgoingMessage);
			vscode.window.showInformationMessage(
				"模型测试功能未启用：请在设置中开启 libiaoCopilot.modelTestEnabled（高级/隐藏参数）。"
			);
			return;
		}

		this.modelTestRunning = true;
		this.modelTestCancelToken = new vscode.CancellationTokenSource();
		this.sendTestStatus();

		let done = 0;
		let total = 0;
		try {
			const { tested, succeeded } = await runModelTests({
				secrets: this.secrets,
				// 列表就绪：一次性把全部待测模型发给前端，立即渲染整张表（等待态）
				onList: (modelIds) => {
					total = modelIds.length;
					this.panel.webview.postMessage({ type: "modelTestStarted", modelIds } as OutgoingMessage);
				},
				// 单个模型开工：前端把对应行从"等待"切到"测试中"
				onRunning: (modelId) => {
					this.panel.webview.postMessage({ type: "modelTestRowRunning", modelId } as OutgoingMessage);
				},
				onResult: (result) => {
					done++;
					this.panel.webview.postMessage({
						type: "modelTestResult",
						result,
						done,
						total,
					} as OutgoingMessage);
				},
				// 传入面板级取消 token：用户点「取消测试」时中断整个流程
				token: this.modelTestCancelToken.token,
				// 只测勾选的模型
				modelIds,
			});

			this.panel.webview.postMessage({
				type: "modelTestDone",
				tested,
				succeeded,
				total,
			} as OutgoingMessage);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.panel.webview.postMessage({
				type: "modelTestResult",
				result: { modelId: "__error__", ok: false, error: errorMessage },
				done: ++done,
				total: Math.max(total, done),
			} as OutgoingMessage);
		} finally {
			this.modelTestRunning = false;
			this.modelTestCancelToken?.dispose();
			this.modelTestCancelToken = undefined;
			this.sendTestStatus();
		}
	}

	/**
	 * 取消当前测试流程（若在运行中）。
	 */
	private cancelModelTests() {
		if (this.modelTestRunning && this.modelTestCancelToken) {
			this.modelTestCancelToken.cancel();
		}
	}

	private async handleConfirmRequest(id: string, message: string, action: string) {
		let confirmed: boolean | string | undefined;

		if (action === "showInfo") {
			// For informational messages, just show the message without confirmation
			await vscode.window.showInformationMessage(message);
			confirmed = true;
		} else {
			// For confirmation requests, show Yes/No dialog
			confirmed = await vscode.window.showInformationMessage(message, { modal: true }, "是", "否");
		}

		// Send response back to webview
		this.panel.webview.postMessage({
			type: "confirmResponse",
			id: id,
			confirmed: action === "showInfo" ? true : confirmed === "是",
		} as OutgoingMessage);
	}

	private async sendInit() {
		const config = vscode.workspace.getConfiguration();
		const baseUrl = config.get<string>("libiaoCopilot.baseUrl", "https://api.openai.com/v1");
		// 前端展示用：vision 缺失时从内置模型表兜底（内置表是 vision 的权威来源，
		// 显示名 emoji 由 vision 驱动，见 configView.js formatModelDisplayName）
		const builtInForVision = getBuiltInModels();
		const models = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", [])).map((m) => ({
			...m,
			vision: m.vision ?? builtInForVision.get(m.id)?.vision,
		}));

		const apiKey = (await this.secrets.get("libiaoCopilot.apiKey")) ?? "";
		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const normalized = provider.toLowerCase();
			let key = await this.secrets.get(`libiaoCopilot.apiKey.${normalized}`);
			if (!key && normalized !== provider) {
				// Backward compat: previous versions stored provider keys with original casing.
				const legacy = await this.secrets.get(`libiaoCopilot.apiKey.${provider}`);
				if (legacy) {
					key = legacy;
					await this.secrets.store(`libiaoCopilot.apiKey.${normalized}`, legacy);
					await this.secrets.delete(`libiaoCopilot.apiKey.${provider}`);
				}
			}
			if (key) {
				providerKeys[provider] = key;
			}
		}

		const delay = config.get<number>("libiaoCopilot.delay", 0);
		const retry = config.get<{
			enabled?: boolean;
			max_attempts?: number;
			interval_ms?: number;
			status_codes?: number[];
		}>("libiaoCopilot.retry", {
			enabled: true,
			max_attempts: 3,
			interval_ms: 1000,
		});

		const commitModel = config.get<string>("libiaoCopilot.commitModel", "deepseek-v4-flash");
		const commitLanguage = config.get<string>("libiaoCopilot.commitLanguage", "Chinese (Simplified)");

		// 提交模型下拉列表：用户配置（排除 __provider__ 占位）∪ 内置模型，按 id+configId 去重
		const builtInModels = getBuiltInModels();
		const seen = new Set<string>();
		const commitModels: HFModelItem[] = [];
		for (const m of [...models.filter((model) => !model.id.startsWith("__provider__")), ...builtInModels.values()]) {
			const key = `${m.id}::${m.configId ?? ""}`;
			if (!seen.has(key)) {
				seen.add(key);
				commitModels.push(m);
			}
		}

		const readFileLines = config.get<number>("libiaoCopilot.readFileLines", 0);
		const visionIcon = config.get<string>("libiaoCopilot.visionIcon", "picture");
		const contextManagement = config.get<string>("libiaoCopilot.contextManagement", "summarize");
		const summarizationInstructions = config.get<string>("libiaoCopilot.summarizationInstructions", "");
		const summarizeMaxTokens = config.get<number>("libiaoCopilot.summarizeMaxTokens", 4000);
		// 隐藏高级参数：默认 false，仅管理员手动编辑 settings.json 启用（保存/导出/导入不迁移）
		const modelTestEnabled = config.get<boolean>("libiaoCopilot.modelTestEnabled", false);
		const payload: InitPayload = {
			baseUrl,
			apiKey,
			delay,
			readFileLines,
			retry,
			commitModel,
			commitModels,
			commitLanguage,
			visionIcon,
			contextManagement,
			summarizationInstructions,
			summarizeMaxTokens,
			models,
			providerKeys,
			modelTestEnabled,
		};
		this.panel.webview.postMessage({ type: "init", payload });
	}

	private async saveGlobalConfig(
		rawBaseUrl: string,
		rawApiKey: string,
		delay: number,
		readFileLines: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] },
		commitModel: string,
		commitLanguage: string,
		visionIcon: string,
		contextManagement: string,
		summarizationInstructions: string,
		summarizeMaxTokens: number
	) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("libiaoCopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		await config.update("libiaoCopilot.delay", delay, vscode.ConfigurationTarget.Global);
		await config.update("libiaoCopilot.readFileLines", readFileLines, vscode.ConfigurationTarget.Global);
		await config.update("libiaoCopilot.retry", retry, vscode.ConfigurationTarget.Global);
		await config.update("libiaoCopilot.commitLanguage", commitLanguage, vscode.ConfigurationTarget.Global);
		await config.update(
			"libiaoCopilot.visionIcon",
			visionIcon === "picture" ? "picture" : "eye",
			vscode.ConfigurationTarget.Global
		);
		await config.update(
			"libiaoCopilot.contextManagement",
			contextManagement === "off" ? "off" : "summarize",
			vscode.ConfigurationTarget.Global
		);
		await config.update(
			"libiaoCopilot.summarizationInstructions",
			summarizationInstructions,
			vscode.ConfigurationTarget.Global
		);
		await config.update("libiaoCopilot.summarizeMaxTokens", summarizeMaxTokens, vscode.ConfigurationTarget.Global);
		await config.update("libiaoCopilot.commitModel", commitModel.trim(), vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.secrets.store("libiaoCopilot.apiKey", apiKey);
		} else {
			await this.secrets.delete("libiaoCopilot.apiKey");
		}

		vscode.window.showInformationMessage("全局配置（Base URL、请求延迟、重试和 API Key）已保存。");
		// Send refresh signal to frontend
		await this.sendInit();
	}

	/**
	 * 重置模型列表：只保留自定义供应商（__provider__ 前缀条目）。
	 * 没有自定义供应商时删除配置键，让 package.json 内置模型默认值生效
	 * （写入空数组会覆盖默认值，导致模型选择器走 API fallback 路径）。
	 */
	private async resetModelList() {
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));
		const preserved = models.filter((m) => m.id.startsWith("__provider__"));
		if (preserved.length > 0) {
			await config.update("libiaoCopilot.models", preserved, vscode.ConfigurationTarget.Global);
		} else {
			// 无自定义供应商：删除配置键，恢复 package.json 内置模型默认值
			await config.update("libiaoCopilot.models", undefined, vscode.ConfigurationTarget.Global);
		}
		clearModelListCache();
		vscode.window.showInformationMessage("模型列表已重置为内置模型 + 自定义供应商。");
		await this.sendInit();
	}

	private async getHtml(webview: vscode.Webview) {
		const nonce = this.getNonce();
		const assetsRoot = vscode.Uri.joinPath(this.extensionUri, "assets", "configView");
		const templatePath = vscode.Uri.joinPath(assetsRoot, "configView.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.js"));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(templatePath);
		let html = new TextDecoder("utf-8").decode(raw);
		html = html
			.replaceAll("%CSP_SOURCE%", csp)
			.replaceAll("%NONCE%", nonce)
			.replace("%CSS_URI%", cssUri.toString())
			.replace("%SCRIPT_URI%", jsUri.toString());
		return html;
	}

	private getNonce() {
		return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
	}

	private async addModel(model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("libiaoCopilot.models", []);

		// Check if model with same id and configId already exists
		const existingIndex = models.findIndex(
			(m) =>
				m.id === model.id && ((model.configId && m.configId === model.configId) || (!model.configId && !m.configId))
		);
		if (existingIndex !== -1) {
			vscode.window.showErrorMessage(`模型 ${model.id}${model.configId ? "::" + model.configId : ""} 已存在。`);
			return;
		}

		models.push(ensureModelContextDefaults(model));
		await config.update("libiaoCopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`模型 ${model.id}${model.configId ? "::" + model.configId : ""} 已添加。`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async updateModel(model: HFModelItem, originalModelId?: string, originalConfigId?: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("libiaoCopilot.models", []);

		// Find the model to update based on original id and configId
		const updatedModels = models.map((m) => {
			// Check if this is the model we want to update
			// If originalConfigId is undefined (meaning it was originally null/undefined),
			// then look for a model with no configId
			const isTargetModel =
				m.id === originalModelId &&
				((originalConfigId && m.configId === originalConfigId) || (!originalConfigId && !m.configId));

			if (isTargetModel) {
				// Update with new values
				return ensureModelContextDefaults(model);
			}
			return m;
		});

		await config.update("libiaoCopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`模型 ${model.id}${model.configId ? "::" + model.configId : ""} 已更新。`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteModel(modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("libiaoCopilot.models", []);
		const parsedModelId = parseModelId(modelId);

		const filteredModels = models.filter((model) => {
			return !(
				model.id === parsedModelId.baseId &&
				((parsedModelId.configId && model.configId === parsedModelId.configId) ||
					(!parsedModelId.configId && !model.configId))
			);
		});

		await config.update("libiaoCopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`模型 ${modelId} 已删除。`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async exportConfig() {
		try {
			const config = vscode.workspace.getConfiguration();
			const baseUrl = config.get<string>("libiaoCopilot.baseUrl", "https://api.openai.com/v1");
			const apiKey = (await this.secrets.get("libiaoCopilot.apiKey")) ?? "";
			const delay = config.get<number>("libiaoCopilot.delay", 0);
			const retry = config.get<{
				enabled?: boolean;
				max_attempts?: number;
				interval_ms?: number;
				status_codes?: number[];
			}>("libiaoCopilot.retry", {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
			});
			const commitLanguage = config.get<string>("libiaoCopilot.commitLanguage", "Chinese (Simplified)");
			const readFileLines = config.get<number>("libiaoCopilot.readFileLines", 0);
			const visionIcon = config.get<string>("libiaoCopilot.visionIcon", "picture");
			const contextManagement = config.get<string>("libiaoCopilot.contextManagement", "summarize");
			const summarizationInstructions = config.get<string>("libiaoCopilot.summarizationInstructions", "");
			const summarizeMaxTokens = config.get<number>("libiaoCopilot.summarizeMaxTokens", 4000);
			const models = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));

			const commitModel = config.get<string>("libiaoCopilot.commitModel", "deepseek-v4-flash");

			const providerKeys: Record<string, string> = {};
			const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
			for (const provider of providers) {
				const normalized = provider.toLowerCase();
				const key = await this.secrets.get(`libiaoCopilot.apiKey.${normalized}`);
				if (key) {
					providerKeys[provider] = key;
				}
			}

			const exportData: ExportConfig = {
				version: VersionManager.getVersion(),
				exportDate: new Date().toISOString(),
				baseUrl,
				apiKey,
				delay,
				retry,
				commitLanguage,
				commitModel,
				visionIcon,
				contextManagement,
				summarizationInstructions,
				summarizeMaxTokens,
				models,
				readFileLines,
				providerKeys,
			};

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`libiaoCopilot-config-${new Date().toISOString().split("T")[0]}.json`),
				filters: { "JSON Files": ["json"] },
				title: "导出 Libiao Copilot 配置",
			});

			if (!uri) {
				vscode.window.showInformationMessage("已取消导出配置。");
				return;
			}

			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, encoder.encode(JSON.stringify(exportData, null, 2)));

			vscode.window.showInformationMessage(`配置已导出到 ${uri.fsPath}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "未知错误";
			vscode.window.showErrorMessage(`导出配置失败：${errorMessage}`);
		}
	}

	private async importConfig() {
		try {
			const uri = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { "JSON Files": ["json"] },
				title: "导入 Libiao Copilot 配置",
			});

			if (!uri || uri.length === 0) {
				vscode.window.showInformationMessage("已取消导入配置。");
				return;
			}

			const content = await vscode.workspace.fs.readFile(uri[0]);
			const decoder = new TextDecoder();
			const jsonContent = decoder.decode(content);
			const importData = JSON.parse(jsonContent) as ExportConfig;

			if (!Array.isArray(importData.models)) {
				throw new Error("配置文件无效：models 必须是数组");
			}

			const config = vscode.workspace.getConfiguration();

			await config.update("libiaoCopilot.baseUrl", importData.baseUrl, vscode.ConfigurationTarget.Global);
			await config.update("libiaoCopilot.delay", importData.delay, vscode.ConfigurationTarget.Global);
			await config.update("libiaoCopilot.retry", importData.retry, vscode.ConfigurationTarget.Global);
			await config.update("libiaoCopilot.readFileLines", importData.readFileLines, vscode.ConfigurationTarget.Global);
			await config.update("libiaoCopilot.commitLanguage", importData.commitLanguage, vscode.ConfigurationTarget.Global);
			if (importData.visionIcon === "picture" || importData.visionIcon === "eye") {
				await config.update("libiaoCopilot.visionIcon", importData.visionIcon, vscode.ConfigurationTarget.Global);
			}
			if (importData.commitModel) {
				await config.update("libiaoCopilot.commitModel", importData.commitModel, vscode.ConfigurationTarget.Global);
			}
			if (importData.contextManagement) {
				await config.update(
					"libiaoCopilot.contextManagement",
					importData.contextManagement === "off" ? "off" : "summarize",
					vscode.ConfigurationTarget.Global
				);
			}
			if (importData.summarizationInstructions !== undefined) {
				await config.update(
					"libiaoCopilot.summarizationInstructions",
					importData.summarizationInstructions,
					vscode.ConfigurationTarget.Global
				);
			}
			if (typeof importData.summarizeMaxTokens === "number") {
				await config.update(
					"libiaoCopilot.summarizeMaxTokens",
					importData.summarizeMaxTokens,
					vscode.ConfigurationTarget.Global
				);
			}

			if (importData.apiKey) {
				await this.secrets.store("libiaoCopilot.apiKey", importData.apiKey);
			} else {
				await this.secrets.delete("libiaoCopilot.apiKey");
			}

			await config.update(
				"libiaoCopilot.models",
				importData.models.map((model) => ensureModelContextDefaults(model)),
				vscode.ConfigurationTarget.Global
			);

			for (const [provider, key] of Object.entries(importData.providerKeys)) {
				const normalized = provider.toLowerCase();
				if (key) {
					await this.secrets.store(`libiaoCopilot.apiKey.${normalized}`, key);
				} else {
					await this.secrets.delete(`libiaoCopilot.apiKey.${normalized}`);
				}
			}

			vscode.window.showInformationMessage("配置导入成功。");
			await this.sendInit();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "未知错误";
			vscode.window.showErrorMessage(`导入配置失败：${errorMessage}`);
		}
	}
}
