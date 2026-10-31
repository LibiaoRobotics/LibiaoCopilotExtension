/**
 * 企微对话桥接的持久化：非敏感设置进 globalState，BotID / Secret 进 SecretStorage。
 *
 * 为什么不落 .psd1 / 工作区文件：这份配置属于「人」，不属于某个项目，
 * 而且 Secret 绝不能出现在可能被提交的文本文件里。
 */
import * as vscode from "vscode";
import {
	DEFAULT_WECHAT_BRIDGE_SETTINGS,
	sanitizeWechatBridgeSettings,
	type WechatBridgeSettings,
} from "./wechatBridgeSettings";

const SETTINGS_KEY = "libiaoCopilot.wechatBridge.settings";
const BOT_ID_KEY = "libiaoCopilot.wechatBridge.botId";
const SECRET_KEY = "libiaoCopilot.wechatBridge.secret";

export interface WechatBridgeCredentials {
	botId: string;
	secret: string;
}

export function readWechatBridgeSettings(context: vscode.ExtensionContext): WechatBridgeSettings {
	const stored = context.globalState.get<Partial<WechatBridgeSettings>>(SETTINGS_KEY);
	return sanitizeWechatBridgeSettings(stored ?? DEFAULT_WECHAT_BRIDGE_SETTINGS);
}

export async function writeWechatBridgeSettings(
	context: vscode.ExtensionContext,
	input: Partial<WechatBridgeSettings>
): Promise<WechatBridgeSettings> {
	const settings = sanitizeWechatBridgeSettings(input);
	await context.globalState.update(SETTINGS_KEY, settings);
	return settings;
}

export async function readWechatBridgeCredentials(
	context: vscode.ExtensionContext
): Promise<WechatBridgeCredentials> {
	const botId = (await context.secrets.get(BOT_ID_KEY)) ?? "";
	const secret = (await context.secrets.get(SECRET_KEY)) ?? "";
	return { botId: botId.trim(), secret: secret.trim() };
}

/** 返回是否有改动；空 secret 表示「保持原值不变」，便于面板只改 BotID */
export async function writeWechatBridgeCredentials(
	context: vscode.ExtensionContext,
	input: { botId?: string; secret?: string }
): Promise<void> {
	if (input.botId !== undefined) {
		const botId = input.botId.trim();
		if (botId) {
			await context.secrets.store(BOT_ID_KEY, botId);
		} else {
			await context.secrets.delete(BOT_ID_KEY);
		}
	}
	if (input.secret !== undefined && input.secret.trim()) {
		await context.secrets.store(SECRET_KEY, input.secret.trim());
	}
}

export async function clearWechatBridgeCredentials(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(BOT_ID_KEY);
	await context.secrets.delete(SECRET_KEY);
}

/** Secret 不回显，只告诉界面「有没有配」 */
export function hasWechatBridgeCredentials(credentials: WechatBridgeCredentials): boolean {
	return Boolean(credentials.botId && credentials.secret);
}
