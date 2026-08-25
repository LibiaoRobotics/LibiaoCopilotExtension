import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId, getBuiltInModels } from "../utils";
import { fetchModels, clearModelListCache } from "../provideModel";
import { ensureModelContextDefaults } from "../modelConfiguration";
import { VersionManager } from "../versionManager";
import { loadTestModelList, runModelTests, type ModelTestResult, type TestModelInfo } from "../modelTester";
import { tokenizerManager } from "../tokenizer/tokenizerManager";

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
	userMemory: {
		filePath: string;
		exists: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
		userName: string;
	};
	customMemory: {
		filePath: string;
		exists: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
	};
	orgInstructions: {
		filePath: string;
		exists: boolean;
		hasContent: boolean;
		isWritable: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
	};
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
	| { type: "cancelModelTest" }
	| { type: "getUserMemoryStatus" }
	| { type: "applyUserMemoryTemplate"; userName?: string }
	| { type: "updateUserMemoryName"; userName?: string }
	| { type: "openUserMemoryFile"; userName?: string }
	| { type: "openCustomMemoryFile" }
	| { type: "deleteCustomMemory" }
	| { type: "openOrgInstructionsFile" }
	| { type: "sanitizeOrgInstructions" }
	| { type: "evaluateOrgInstructions" }
	| { type: "evaluateUserMemory" }
	| { type: "evaluateCustomMemory" }
	| { type: "evaluateCombinedMemory" }
	| { type: "revealUserMemoryFolder" };

type OutgoingMessage =
	| { type: "init"; payload: InitPayload }
	| { type: "modelsFetched"; models: HFModelItem[] }
	| { type: "modelTestListLoaded"; models: TestModelInfo[]; exclude: string[] }
	| { type: "modelTestListError"; error: string }
	| { type: "confirmResponse"; id: string; confirmed: boolean }
	| { type: "modelTestStarted"; models: TestModelInfo[] }
	| { type: "modelTestRowRunning"; modelId: string }
	| {
			type: "modelTestResult";
			result: ModelTestResult;
			done: number;
			total: number;
	  }
	| { type: "modelTestDone"; tested: number; succeeded: number; total: number }
	| { type: "modelTestStatus"; testing: boolean }
	| {
			type: "userMemoryStatus";
			userMemory: {
				filePath: string;
				exists: boolean;
				lineCount: number;
				charCount: number;
				tokenCount: number;
				userName: string;
			};
			customMemory: {
				filePath: string;
				exists: boolean;
				lineCount: number;
				charCount: number;
				tokenCount: number;
			};
			orgInstructions: {
				filePath: string;
				exists: boolean;
				hasContent: boolean;
				isWritable: boolean;
				lineCount: number;
				charCount: number;
				tokenCount: number;
			};
	  };

export class ConfigViewPanel {
	public static currentPanel: ConfigViewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly secrets: vscode.SecretStorage;
	private readonly globalStorageUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];
	// 模型测试会话状态（面板级，防止面板重建后状态泄漏）
	private modelTestRunning = false;
	private modelTestCancelToken: vscode.CancellationTokenSource | undefined;

	public static openPanel(
		extensionUri: vscode.Uri,
		secrets: vscode.SecretStorage,
		globalStorageUri: vscode.Uri
	) {
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

		ConfigViewPanel.currentPanel = new ConfigViewPanel(panel, extensionUri, secrets, globalStorageUri);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		secrets: vscode.SecretStorage,
		globalStorageUri: vscode.Uri
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.secrets = secrets;
		this.globalStorageUri = globalStorageUri;

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
			case "getUserMemoryStatus": {
				await this.postAllMemoryStatus();
				break;
			}
			case "applyUserMemoryTemplate":
				await this.applyUserMemoryTemplate(message.userName);
				break;
			case "updateUserMemoryName":
				await this.updateUserMemoryName(message.userName);
				break;
			case "openUserMemoryFile":
				await this.openUserMemoryFile(message.userName);
				break;
			case "openCustomMemoryFile":
				await this.openCustomMemoryFile();
				break;
			case "deleteCustomMemory":
				await this.deleteCustomMemory();
				break;
			case "openOrgInstructionsFile":
				await this.openOrgInstructionsFile();
				break;
			case "sanitizeOrgInstructions":
				await this.sanitizeOrgInstructions();
				break;
			case "evaluateOrgInstructions":
				await this.evaluateOrgInstructions();
				break;
			case "evaluateUserMemory":
				await this.evaluateUserMemory();
				break;
			case "evaluateCustomMemory":
				await this.evaluateCustomMemory();
				break;
			case "evaluateCombinedMemory":
				await this.evaluateCombinedMemory();
				break;
			case "revealUserMemoryFolder":
				await this.revealUserMemoryFolder();
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
			const { models, reason } = await loadTestModelList(this.secrets);
			const exclude = this.readModelTestExclude();
			if (models.length === 0) {
				this.panel.webview.postMessage({
					type: "modelTestListLoaded",
					models: [],
					exclude: [],
				} as OutgoingMessage);
				if (reason) {
					this.panel.webview.postMessage({ type: "modelTestListError", error: reason } as OutgoingMessage);
				}
				return;
			}
			this.panel.webview.postMessage({
				type: "modelTestListLoaded",
				models,
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
				onList: (models) => {
					total = models.length;
					this.panel.webview.postMessage({ type: "modelTestStarted", models } as OutgoingMessage);
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
		const userMemory = await this.getUserMemoryStatus();
		const customMemory = await this.getCustomMemoryStatus();
		const orgInstructions = await this.getOrgInstructionsStatus();
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
			userMemory,
			customMemory,
			orgInstructions,
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

	private getMemoryFilePath(): string {
		const globalStorageRoot = path.dirname(this.globalStorageUri.fsPath);
		return path.join(globalStorageRoot, "github.copilot-chat", "memory-tool", "memories", "user-preferences.md");
	}

	private getCustomMemoryFilePath(): string {
		const globalStorageRoot = path.dirname(this.globalStorageUri.fsPath);
		return path.join(globalStorageRoot, "github.copilot-chat", "memory-tool", "memories", "custom-notes.md");
	}

	private getOrgInstructionsFilePath(): string {
		const globalStorageRoot = path.dirname(this.globalStorageUri.fsPath);
		return findOrgInstructionsFilePath(globalStorageRoot);
	}

	private getMemoryDirPath(): string {
		const globalStorageRoot = path.dirname(this.globalStorageUri.fsPath);
		return path.join(globalStorageRoot, "github.copilot-chat", "memory-tool", "memories");
	}

	private async getUserMemoryStatus(): Promise<{
		filePath: string;
		exists: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
		userName: string;
	}> {
		const filePath = this.getMemoryFilePath();
		let exists = false;
		let lineCount = 0;
		let charCount = 0;
		let tokenCount = 0;
		let userName = "";
		try {
			if (fs.existsSync(filePath)) {
				exists = true;
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split(/\r?\n/);
				lineCount = lines.length;
				charCount = content.length;
				userName = extractUserNameFromMemory(content);
				try {
					tokenCount = await tokenizerManager.countTokens(content);
				} catch (err) {
					console.error("[libiaoCopilot] countTokens failed", err);
					tokenCount = Math.round(charCount * 0.65);
				}
			}
		} catch (err) {
			console.error("[libiaoCopilot] check user memory failed", err);
		}
		return { filePath, exists, lineCount, charCount, tokenCount, userName };
	}

	private async getCustomMemoryStatus(): Promise<{
		filePath: string;
		exists: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
	}> {
		const filePath = this.getCustomMemoryFilePath();
		let exists = false;
		let lineCount = 0;
		let charCount = 0;
		let tokenCount = 0;
		try {
			if (fs.existsSync(filePath)) {
				exists = true;
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split(/\r?\n/);
				lineCount = lines.length;
				charCount = content.length;
				try {
					tokenCount = await tokenizerManager.countTokens(content);
				} catch (err) {
					console.error("[libiaoCopilot] countTokens for custom memory failed", err);
					tokenCount = Math.round(charCount * 0.65);
				}
			}
		} catch (err) {
			console.error("[libiaoCopilot] check custom memory failed", err);
		}
		return { filePath, exists, lineCount, charCount, tokenCount };
	}

	private async getOrgInstructionsStatus(): Promise<{
		filePath: string;
		exists: boolean;
		hasContent: boolean;
		isWritable: boolean;
		lineCount: number;
		charCount: number;
		tokenCount: number;
	}> {
		const filePath = this.getOrgInstructionsFilePath();
		let exists = false;
		let hasContent = false;
		let isWritable = false;
		let lineCount = 0;
		let charCount = 0;
		let tokenCount = 0;
		try {
			if (fs.existsSync(filePath)) {
				exists = true;
				const content = fs.readFileSync(filePath, "utf-8");
				hasContent = content.trim().length > 0;
				const lines = content.split(/\r?\n/);
				lineCount = hasContent ? lines.length : 0;
				charCount = content.length;
				isWritable = isFileWritable(filePath);
				if (hasContent) {
					try {
						tokenCount = await tokenizerManager.countTokens(content);
					} catch (err) {
						tokenCount = Math.round(charCount * 0.65);
					}
				}
			}
		} catch (err) {
			console.error("[libiaoCopilot] check org instructions failed", err);
		}
		return { filePath, exists, hasContent, isWritable, lineCount, charCount, tokenCount };
	}

	private async postAllMemoryStatus() {
		const userMemory = await this.getUserMemoryStatus();
		const customMemory = await this.getCustomMemoryStatus();
		const orgInstructions = await this.getOrgInstructionsStatus();
		this.panel.webview.postMessage({
			type: "userMemoryStatus",
			userMemory,
			customMemory,
			orgInstructions,
		} as OutgoingMessage);
	}

	private async updateUserMemoryName(rawUserName?: string) {
		try {
			const filePath = this.getMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				await this.applyUserMemoryTemplate(rawUserName);
				return;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const newContent = updateUserNameInMemory(content, rawUserName || "");
			if (isMemoryContentEqual(content, newContent)) {
				vscode.window.showInformationMessage("称呼与当前一致，无需更新。");
				return;
			}

			// 保存称呼前先自动备份原记忆至桌面
			let backupPath: string | null = null;
			if (content.trim().length > 0) {
				backupPath = backupMemoryToDesktop(content, undefined, undefined, "user-preferences");
			}

			fs.writeFileSync(filePath, newContent, "utf-8");
			const name = rawUserName?.trim();
			const backupNote = backupPath ? `（原记忆已备份至桌面：${path.basename(backupPath)}）` : "";
			const infoMsg = name
				? `用户核心记忆称呼已更新为「${name}」，其余内容保持不变${backupNote}。`
				: `已从用户核心记忆中移除特定称呼，其余内容保持不变${backupNote}。`;
			vscode.window.showInformationMessage(infoMsg);
			await this.postAllMemoryStatus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`更新称呼失败：${msg}`);
		}
	}

	private async applyUserMemoryTemplate(rawUserName?: string) {
		try {
			const userName = rawUserName && rawUserName.trim() ? rawUserName.trim() : "";
			const templateUri = vscode.Uri.joinPath(
				this.extensionUri,
				"assets",
				"templates",
				"user-preferences.template.md"
			);
			const templateBytes = await vscode.workspace.fs.readFile(templateUri);
			const rawTemplate = new TextDecoder("utf-8").decode(templateBytes);
			const newContent = renderUserMemoryTemplate(rawTemplate, userName);

			const filePath = this.getMemoryFilePath();
			let oldContent = "";
			let hasOldFile = false;
			if (fs.existsSync(filePath)) {
				oldContent = fs.readFileSync(filePath, "utf-8");
				hasOldFile = true;
			}

			// 1. 判断新内容是否与老内容一致，一致则无需修改
			if (hasOldFile && isMemoryContentEqual(oldContent, newContent)) {
				vscode.window.showInformationMessage("当前用户核心记忆内容与待应用的模板完全一致，无需修改。");
				await this.postAllMemoryStatus();
				return;
			}

			let saveToCustom = false;
			// 2. 如果存在旧内容且与新模板不同，弹窗提醒用户选择是否转存为附加记忆
			if (hasOldFile && oldContent.trim().length > 0) {
				const choice = await vscode.window.showInformationMessage(
					`即将应用官方核心记忆模板（称呼：${userName || "无"}）。检测到现有核心记忆已有内容，是否将原内容转存为「附加记忆 (custom-notes.md)」以便继续生效？\n\n（无论如何选择，原文件均会自动备份到桌面）`,
					{ modal: true },
					"转存为附加记忆",
					"仅备份并覆盖",
					"取消"
				);

				if (!choice || choice === "取消") {
					return;
				}
				if (choice === "转存为附加记忆") {
					saveToCustom = true;
				}
			}

			// 3. 执行桌面备份原核心记忆
			let backupPath: string | null = null;
			if (hasOldFile && oldContent.trim().length > 0) {
				backupPath = backupMemoryToDesktop(oldContent, undefined, undefined, "user-preferences");
			}

			// 4. 若选择转存为附加记忆
			const customMemoryPath = this.getCustomMemoryFilePath();
			if (saveToCustom && oldContent.trim().length > 0) {
				const memoryDir = this.getMemoryDirPath();
				if (!fs.existsSync(memoryDir)) {
					fs.mkdirSync(memoryDir, { recursive: true });
				}
				let customContentToSave = oldContent;
				if (fs.existsSync(customMemoryPath)) {
					const existingCustom = fs.readFileSync(customMemoryPath, "utf-8");
					if (existingCustom.trim().length > 0) {
						// 备份旧的 custom 记忆
						backupMemoryToDesktop(existingCustom, undefined, undefined, "custom-notes");
						customContentToSave = existingCustom + "\n\n---\n\n" + oldContent;
					}
				}
				fs.writeFileSync(customMemoryPath, customContentToSave, "utf-8");
			}

			// 5. 写入核心记忆
			const memoryDir = this.getMemoryDirPath();
			if (!fs.existsSync(memoryDir)) {
				fs.mkdirSync(memoryDir, { recursive: true });
			}
			fs.writeFileSync(filePath, newContent, "utf-8");

			const backupNote = backupPath ? `（原记忆已备份至桌面：${path.basename(backupPath)}）` : "";
			const customNote = saveToCustom ? "，原内容已同步转存至附加记忆 (custom-notes.md)" : "";
			const infoMsg = userName
				? `用户核心记忆模板应用成功（称呼已设置为：${userName}）${customNote}${backupNote}。`
				: `用户核心记忆模板应用成功（未设定称呼规则）${customNote}${backupNote}。`;
			vscode.window.showInformationMessage(infoMsg);
			await this.postAllMemoryStatus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`应用用户核心记忆模板失败：${msg}`);
		}
	}

	private async openUserMemoryFile(rawUserName?: string) {
		try {
			const filePath = this.getMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				await this.applyUserMemoryTemplate(rawUserName);
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`打开核心记忆文件失败：${msg}`);
		}
	}

	private async openCustomMemoryFile() {
		try {
			const filePath = this.getCustomMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				const memoryDir = this.getMemoryDirPath();
				if (!fs.existsSync(memoryDir)) {
					fs.mkdirSync(memoryDir, { recursive: true });
				}
				const initialContent = `# 自定义附加记忆 (Custom Notes)\n\n## 个人偏好与业务规则\n\n- 在此添加您个人的编码习惯、专属术语、特定框架约定等。\n- 本文件与核心记忆一同被 Copilot 作为用户全局记忆自动读取。\n`;
				fs.writeFileSync(filePath, initialContent, "utf-8");
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(doc, { preview: false });
			await this.postAllMemoryStatus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`打开附加记忆文件失败：${msg}`);
		}
	}

	private async deleteCustomMemory() {
		try {
			const filePath = this.getCustomMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("自定义附加记忆文件不存在，无需删除。");
				await this.postAllMemoryStatus();
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				"确定要删除自定义附加记忆文件 (custom-notes.md) 吗？删除前原内容将自动备份至桌面。",
				{ modal: true },
				"确定删除",
				"取消"
			);
			if (confirmed !== "确定删除") {
				return;
			}

			const content = fs.readFileSync(filePath, "utf-8");
			let backupPath: string | null = null;
			if (content.trim().length > 0) {
				backupPath = backupMemoryToDesktop(content, undefined, undefined, "custom-notes");
			}

			fs.unlinkSync(filePath);
			const backupNote = backupPath ? `（原内容已备份至桌面：${path.basename(backupPath)}）` : "";
			vscode.window.showInformationMessage(`自定义附加记忆文件已成功删除${backupNote}。`);
			await this.postAllMemoryStatus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`删除自定义附加记忆失败：${msg}`);
		}
	}

	private async revealUserMemoryFolder() {
		try {
			const dirPath = this.getMemoryDirPath();
			if (!fs.existsSync(dirPath)) {
				fs.mkdirSync(dirPath, { recursive: true });
			}
			const filePath = this.getMemoryFilePath();
			if (fs.existsSync(filePath)) {
				await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
			} else {
				await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dirPath));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`定位记忆目录失败：${msg}`);
		}
	}

	private async evaluateUserMemory() {
		try {
			const filePath = this.getMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("用户核心记忆文件尚未创建，请先应用模板或创建文件后再进行诊断。");
				return;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			if (!content.trim()) {
				vscode.window.showInformationMessage("用户核心记忆文件内容为空，请先编写内容后再进行诊断。");
				return;
			}
			const prompt = buildUserMemoryEvaluationPrompt(content);
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`发起核心记忆诊断失败：${msg}`);
		}
	}

	private async evaluateCustomMemory() {
		try {
			const filePath = this.getCustomMemoryFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("自定义附加记忆文件尚未创建，请先创建或转存文件后再进行诊断。");
				return;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			if (!content.trim()) {
				vscode.window.showInformationMessage("自定义附加记忆文件内容为空，请先编写内容后再进行诊断。");
				return;
			}
			const prompt = buildCustomMemoryEvaluationPrompt(content);
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`发起附加记忆诊断失败：${msg}`);
		}
	}

	private async evaluateCombinedMemory() {
		try {
			const userFilePath = this.getMemoryFilePath();
			const customFilePath = this.getCustomMemoryFilePath();
			const userExists = fs.existsSync(userFilePath);
			const customExists = fs.existsSync(customFilePath);

			if (!userExists && !customExists) {
				vscode.window.showInformationMessage("尚未检测到任何记忆文件，请先创建记忆文件后再进行体检。");
				return;
			}
			const userContent = userExists ? fs.readFileSync(userFilePath, "utf-8") : "";
			const customContent = customExists ? fs.readFileSync(customFilePath, "utf-8") : "";

			if (!userContent.trim() && !customContent.trim()) {
				vscode.window.showInformationMessage("两份记忆文件内容均为空，请先编写内容后再进行体检。");
				return;
			}

			const prompt = buildCombinedMemoryEvaluationPrompt(userContent, customContent);
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`发起合并体检失败：${msg}`);
		}
	}

	private async openOrgInstructionsFile() {
		try {
			const filePath = this.getOrgInstructionsFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("组织指令文件不存在。");
				return;
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`打开组织指令文件失败：${msg}`);
		}
	}

	private async sanitizeOrgInstructions() {
		try {
			const filePath = this.getOrgInstructionsFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("组织指令文件不存在，无需排除干扰。");
				await this.postAllMemoryStatus();
				return;
			}

			clearAndLockFile(filePath);
			vscode.window.showInformationMessage("组织指令已成功清空并锁定为只读属性，已成功狙杀并排除干扰！");
			await this.postAllMemoryStatus();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`排除组织指令干扰失败：${msg}`);
		}
	}

	private async evaluateOrgInstructions() {
		try {
			const filePath = this.getOrgInstructionsFilePath();
			if (!fs.existsSync(filePath)) {
				vscode.window.showInformationMessage("组织指令文件不存在，无法进行评理。");
				return;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			if (!content.trim()) {
				vscode.window.showInformationMessage("组织指令文件内容为空，无需评理。");
				return;
			}
			const prompt = buildOrgInstructionsEvaluationPrompt(content);
			await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`发起组织指令评理失败：${msg}`);
		}
	}
}

/**
 * 从核心记忆文件文本中提取用户称呼/昵称。
 * 若未包含称呼设定，安全返回空字符串。
 */
export function extractUserNameFromMemory(content: string): string {
	const match = content.match(/[-*]\s*称呼用户为[“"']?([^“”"'\r\n]+?)[”"']?[。.]?(?:\r?\n|$)/);
	if (match && match[1]) {
		return match[1].trim().replace(/^[“”"']|[“”"']$|[。.]+$/g, "");
	}
	return "";
}

/**
 * 渲染核心记忆模板：
 * 1. 若提供了 userName，替换占位符 {{USER_NAME}}
 * 2. 若未提供 userName，将称呼该行移除，生成干净无称呼限定的记忆内容
 */
export function renderUserMemoryTemplate(template: string, userName?: string): string {
	const trimmed = userName ? userName.trim() : "";
	if (trimmed) {
		return template.replaceAll("{{USER_NAME}}", trimmed);
	}
	return template.replace(/[-*]\s*称呼用户为[“"']?\{\{USER_NAME\}\}[”"']?。?\r?\n/, "");
}

/**
 * 仅更新记忆文件中的称呼设定，保持其他内容完全不变。
 */
export function updateUserNameInMemory(content: string, newUserName: string): string {
	const trimmedName = newUserName.trim();
	const hasNameRegex = /[-*]\s*称呼用户为[“"']?[^“”"'\r\n]+?[”"']?[。.]?(?:\r?\n|$)/;

	if (hasNameRegex.test(content)) {
		if (trimmedName) {
			return content.replace(hasNameRegex, `- 称呼用户为“${trimmedName}”。\n`);
		} else {
			return content.replace(hasNameRegex, "");
		}
	} else {
		if (!trimmedName) {
			return content;
		}
		// 如果存在 ## 沟通 分组，插入到该分组下方
		const communicationHeaderRegex = /(##\s*沟通\s*\r?\n)/;
		if (communicationHeaderRegex.test(content)) {
			return content.replace(communicationHeaderRegex, `$1- 称呼用户为“${trimmedName}”。\n`);
		}
		// 如果存在 # 用户核心记忆 标题，插入到其下方
		const titleHeaderRegex = /(#\s*用户核心记忆\s*\r?\n)/;
		if (titleHeaderRegex.test(content)) {
			return content.replace(titleHeaderRegex, `$1\n## 沟通\n\n- 称呼用户为“${trimmedName}”。\n`);
		}
		// 否则前置
		return `- 称呼用户为“${trimmedName}”。\n\n` + content;
	}
}

/**
 * 比对两份记忆文件内容是否完全一致（归一化换行符与首尾空格）。
 */
export function isMemoryContentEqual(a: string, b: string): boolean {
	const normA = a.replace(/\r\n/g, "\n").trim();
	const normB = b.replace(/\r\n/g, "\n").trim();
	return normA === normB;
}

/**
 * 获取跨平台的系统桌面目录。
 * 若 Desktop 目录不存在，安全回退至用户 Home 目录。
 */
export function getDesktopDirPath(): string {
	const desktop = path.join(os.homedir(), "Desktop");
	if (fs.existsSync(desktop)) {
		return desktop;
	}
	return os.homedir();
}

/**
 * 格式化备份文件时间戳 (YYYYMMDD_HHmmss)。
 */
export function formatBackupTimestamp(date: Date = new Date()): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	const YYYY = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const DD = pad(date.getDate());
	const hh = pad(date.getHours());
	const mm = pad(date.getMinutes());
	const ss = pad(date.getSeconds());
	return `${YYYY}${MM}${DD}_${hh}${mm}${ss}`;
}

/**
 * 将现有的记忆文件内容备份至桌面。
 * 返回生成的备份文件完整绝对路径。
 */
export function backupMemoryToDesktop(
	content: string,
	customTargetDir?: string,
	customDate?: Date,
	filePrefix: string = "user-preferences"
): string | null {
	if (!content || !content.trim()) {
		return null;
	}
	const targetDir = customTargetDir || getDesktopDirPath();
	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}
	const ts = formatBackupTimestamp(customDate || new Date());
	const fileName = `${filePrefix}.backup.${ts}.md`;
	const filePath = path.join(targetDir, fileName);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/**
 * 组装核心记忆 AI 评估诊断 Prompt。
 */
export function buildUserMemoryEvaluationPrompt(userMemoryContent: string): string {
	return `请作为大语言模型与 Agent 工程专家，对以下「用户核心记忆文件 (user-preferences.md)」进行专业、严谨的体检与诊断评估。

## 待评估的核心记忆内容：
\`\`\`markdown
${userMemoryContent.trim()}
\`\`\`

## 请从以下维度进行结构化评估并给出具体建议：
1. **指令有效性与可遵循度**：是否存在过于模糊、具有歧义、或容易被大模型忽略的负向表述（“不要”、“禁止”类句式在大模型注意力衰减时容易失效）？
2. **实证主义与工程防线**：在代码修改、重构限制、自动化验证、错误处理和止损机制上的规则是否足够严密？
3. **Token 与行数预算效率**：信息密度如何？是否有冗余车轱辘话？（注：宿主环境每轮自动加载上限为 200 行）。
4. **综合评分 (1-10分) 与 1-3 条关键优化行动建议**。`;
}

/**
 * 组装自定义附加记忆 AI 评估诊断 Prompt。
 */
export function buildCustomMemoryEvaluationPrompt(customMemoryContent: string): string {
	return `请作为大语言模型与 Agent 工程专家，对以下「自定义附加记忆文件 (custom-notes.md)」进行专业、严谨的体检与诊断评估。

## 待评估的附加记忆内容：
\`\`\`markdown
${customMemoryContent.trim()}
\`\`\`

## 请从以下维度进行结构化评估并给出具体建议：
1. **规则清晰度与针对性**：个人偏好、业务规范或特定技术栈约定是否具体、清晰且易于执行？
2. **规范性与结构**：是否遵循单行 bullet-point 与清晰的分级标题？
3. **Token 与行数预算效率**：信息密度如何？是否存在过长冗余表述？
4. **综合评分 (1-10分) 与 1-3 条具体优化建议**。`;
}

/**
 * 组装核心记忆与附加记忆合并体检/冲突排查 Prompt。
 */
export function buildCombinedMemoryEvaluationPrompt(
	userMemoryContent: string,
	customMemoryContent: string
): string {
	return `请作为大语言模型与 Agent 工程专家，对以下同时生效的两份用户记忆文件进行全局「合并体检与冲突排查」：

## 1. 用户核心记忆 (user-preferences.md)：
\`\`\`markdown
${userMemoryContent.trim() || "（未创建或内容为空）"}
\`\`\`

## 2. 自定义附加记忆 (custom-notes.md)：
\`\`\`markdown
${customMemoryContent.trim() || "（未创建或内容为空）"}
\`\`\`

## 请从以下维度进行全方位体检与冲突诊断：
1. **⚠️ 规则冲突与自相矛盾检测**：两份文件之间是否存在相互打架、冲突或优先级模糊的指令？（若有，请逐一明确指出）。
2. **📉 冗余重叠分析**：两份文件是否存在重复强调或同一规则多处书写的情况？
3. **📊 合计预算与截断风险**：两文件总行数与 Token 负载评估（宿主环境每轮自动加载上限为 200 行，评估是否健康）。
4. **🛠️ 终极优化与协同建议**：建议核心记忆保留什么、附加记忆保留什么，以达成最佳协同分工；并可给出优化后的推荐示例。`;
}

/**
 * 寻找组织指令文件的绝对路径。
 */
export function findOrgInstructionsFilePath(globalStorageRoot: string): string {
	const defaultPath = path.join(
		globalStorageRoot,
		"github.copilot-chat",
		"github",
		"libiaorobotics",
		"instructions",
		"default.instructions.md"
	);
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}
	const githubDir = path.join(globalStorageRoot, "github.copilot-chat", "github");
	if (fs.existsSync(githubDir)) {
		try {
			const entries = fs.readdirSync(githubDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const candidate = path.join(githubDir, entry.name, "instructions", "default.instructions.md");
					if (fs.existsSync(candidate)) {
						return candidate;
					}
				}
			}
		} catch {}
	}
	return defaultPath;
}

/**
 * 检查文件是否处于可写状态（未被设为只读）。
 */
export function isFileWritable(filePath: string): boolean {
	if (!fs.existsSync(filePath)) {
		return false;
	}
	try {
		fs.accessSync(filePath, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 清空文件内容并将其属性锁定为只读。
 */
export function clearAndLockFile(filePath: string): void {
	if (!fs.existsSync(filePath)) {
		return;
	}
	// 先确保解除只读锁，以便清空内容
	try {
		fs.chmodSync(filePath, 0o666);
	} catch {}
	fs.writeFileSync(filePath, "", "utf-8");
	// 设置为只读 (Windows 下等效为 FILE_ATTRIBUTE_READONLY, POSIX 下为 0o444)
	fs.chmodSync(filePath, 0o444);
}

/**
 * 组装组织指令 AI 评审/评理 Prompt。
 */
export function buildOrgInstructionsEvaluationPrompt(orgInstructionsContent: string): string {
	return `请作为大语言模型与 Agent 架构专家，对以下由组织管理员下发的「组织级全局指令文件 (default.instructions.md)」进行客观、严谨且一针见血的评审与评理：

## 待评审的组织指令内容：
\`\`\`markdown
${orgInstructionsContent.trim()}
\`\`\`

## 请从以下维度进行深度审视与评理：
1. **⚖️ 评理与痛点诊断**：这些指令中是否存在过多损害开发效率的微操限制（Micro-management）、自相矛盾、假大空套话或与大模型注意力机制相悖的反模式？
2. **⚠️ 潜在副作用与隐式污染**：这些指令在每轮会话中被隐式全量注入后，会导致大模型出现哪些负面症状（如：思考迟钝、拒绝执行必要改动、幻觉加剧、严重浪费 Token 等）？
3. **💡 改造与精简建议**：如果必须保留组织级规范，应如何精简重构为“克制、有效、真正利于开发”的高信噪比指令？
4. **🎯 综合评语与扎心总结**（请用专业且鲜明的语言总结这份指令的质量）。`;
}


