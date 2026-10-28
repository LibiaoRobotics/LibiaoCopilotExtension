import * as vscode from "vscode";
import {
	readWechatNotifyConfigState,
	resolveWechatNotifyConfigUri,
	writeWechatNotifyConfig,
} from "../wechatNotifyConfig";
import {
	createWechatNotifyHook,
	readWechatNotifySetupState,
	updateWechatNotifyScript,
	type WechatNotifyCreateResult,
	type WechatNotifyUpdateResult,
} from "../wechatNotifyHookService";
import { launchPowerShellInstaller } from "../powershellManager";
import type { WechatNotifySettings } from "../wechatNotifySettings";
import { sendWechatNotifyTest } from "../wechatNotifyTest";

type IncomingMessage =
	| { type: "requestInit" }
	| { type: "save"; settings: Partial<WechatNotifySettings> }
	| { type: "create"; settings: Partial<WechatNotifySettings> }
	| { type: "updateScript" }
	| { type: "recheckPowerShell" }
	| { type: "installPowerShell" }
	| { type: "openConfigFile" }
	| { type: "testWebhook"; webhook: string };

function describeCreateResult(result: WechatNotifyCreateResult): string {
	const parts: string[] = [];
	if (result.created.length > 0) {
		parts.push(`已创建 ${result.created.join("、")}`);
	}
	if (result.skipped.length > 0) {
		parts.push(`跳过 ${result.skipped.join("、")}（已存在，未覆盖）`);
	}
	return parts.length > 0
		? `企微联动 hook 初始化完成：${parts.join("；")}。`
		: "企微联动 hook 已就绪，无需改动。";
}

function describeUpdateResult(result: WechatNotifyUpdateResult): string {
	const from = result.previousVersion || "旧版";
	const to = result.templateVersion || "最新";
	const backup = result.backupPath ? `原脚本已备份到 ${result.backupPath}。` : "原脚本与模板一致，未产生备份。";
	return `企微联动脚本已更新：${from} → ${to}。${backup}`;
}

/**
 * 「企微联动」独立配置面板。
 *
 * 读写的是工作区里的 .github/hooks/WechatNotify.local.psd1 —— 与
 * WechatNotify.ps1 的 $PSScriptRoot 指向同一份文件，保存后下一次 Stop
 * 触发即生效，无需重载窗口。
 */
export class WechatNotifyViewPanel {
	public static currentPanel: WechatNotifyViewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private onSaved: () => void;
	private disposables: vscode.Disposable[] = [];

	public static openPanel(extensionUri: vscode.Uri, onSaved: () => void): void {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (WechatNotifyViewPanel.currentPanel) {
			WechatNotifyViewPanel.currentPanel.onSaved = onSaved;
			WechatNotifyViewPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"libiaoCopilot.wechatNotify",
			"企微联动",
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "assets", "wechatNotifyView")],
			}
		);

		WechatNotifyViewPanel.currentPanel = new WechatNotifyViewPanel(panel, extensionUri, onSaved);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, onSaved: () => void) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.onSaved = onSaved;

		void this.update();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			(message: IncomingMessage) => {
				this.handleMessage(message).catch((err) => {
					console.error("[libiaoCopilot] wechat notify panel failed", err);
					vscode.window.showErrorMessage(
						err instanceof Error ? err.message : `处理企微联动配置时发生意外错误[${message.type}]。`
					);
				});
			},
			null,
			this.disposables
		);

		void this.sendInit();
	}

	public dispose(): void {
		WechatNotifyViewPanel.currentPanel = undefined;
		this.panel.dispose();
		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}

	private async handleMessage(message: IncomingMessage): Promise<void> {
		switch (message.type) {
			case "requestInit":
				await this.sendInit();
				break;
			case "save": {
				// 界面已禁用按钮，这里再挡一次：没有 pwsh 时保存只会制造"配好但不生效"的假象
				const setup = await readWechatNotifySetupState(this.extensionUri);
				if (!setup.canModify) {
					void vscode.window.showWarningMessage(setup.message);
					await this.postState();
					break;
				}
				await writeWechatNotifyConfig(message.settings);
				await this.postState();
				this.onSaved();
				void vscode.window.showInformationMessage("企微联动配置已保存，下一轮对话结束即生效。");
				break;
			}
			case "create": {
				const result = await createWechatNotifyHook(this.extensionUri, message.settings);
				await this.postState();
				this.onSaved();
				void vscode.window.showInformationMessage(describeCreateResult(result));
				break;
			}
			case "updateScript": {
				const result = await updateWechatNotifyScript(this.extensionUri);
				await this.postState();
				this.onSaved();
				void vscode.window.showInformationMessage(describeUpdateResult(result));
				break;
			}
			case "recheckPowerShell":
				await this.postState(true);
				break;
			case "installPowerShell":
				await launchPowerShellInstaller();
				break;
			case "openConfigFile":
				await this.openConfigFile();
				break;
			case "testWebhook": {
				// 用界面上当前填的地址测，不要求先保存：先验证再落盘才不会把错地址存进 psd1
				const result = await sendWechatNotifyTest(message.webhook);
				await this.panel.webview.postMessage({ type: "testResult", result });
				break;
			}
		}
	}

	private async openConfigFile(): Promise<void> {
		const uri = resolveWechatNotifyConfigUri();
		if (!uri) {
			void vscode.window.showWarningMessage("当前没有打开的工作区，无法定位企微联动配置文件。");
			return;
		}
		const exists = await vscode.workspace.fs.stat(uri).then(
			() => true,
			() => false
		);
		if (!exists) {
			void vscode.window.showWarningMessage("配置文件尚未创建，请先在面板中点击「初始化到此项目」或「保存配置」。");
			return;
		}
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
	}

	private async sendInit(): Promise<void> {
		await this.postState();
	}

	/** 配置与就绪度一起推：面板要靠 canModify 决定能不能写 */
	private async postState(forcePowerShell = false): Promise<void> {
		const config = await readWechatNotifyConfigState();
		const setup = await readWechatNotifySetupState(this.extensionUri, forcePowerShell);
		await this.panel.webview.postMessage({ type: "init", config, setup });
	}

	private async update(): Promise<void> {
		this.panel.webview.html = await this.getHtml(this.panel.webview);
	}

	private async getHtml(webview: vscode.Webview): Promise<string> {
		const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
		const assetsRoot = vscode.Uri.joinPath(this.extensionUri, "assets", "wechatNotifyView");
		const templateUri = vscode.Uri.joinPath(assetsRoot, "wechatNotifyView.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "wechatNotifyView.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "wechatNotifyView.js"));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(templateUri);
		return new TextDecoder("utf-8")
			.decode(raw)
			.replaceAll("%CSP_SOURCE%", csp)
			.replaceAll("%NONCE%", nonce)
			.replace("%CSS_URI%", cssUri.toString())
			.replace("%SCRIPT_URI%", jsUri.toString());
	}
}
