import * as vscode from "vscode";
import { logger } from "./logger";
import {
	DEFAULT_WECHAT_NOTIFY_SETTINGS,
	parseWechatNotifySettings,
	serializeWechatNotifySettings,
	sanitizeWechatNotifySettings,
	type WechatNotifySettings,
} from "./wechatNotifySettings";
import {
	WECHAT_NOTIFY_CONFIG_FILE_NAME as CONFIG_FILE_NAME,
	WECHAT_NOTIFY_HOOK_DIR,
} from "./wechatNotifyPaths";

/** 相对工作区根目录的固定位置，必须与 WechatNotify.ps1 的 $PSScriptRoot 指向一致 */
export const WECHAT_NOTIFY_CONFIG_RELATIVE_DIR = WECHAT_NOTIFY_HOOK_DIR;
export const WECHAT_NOTIFY_CONFIG_FILE_NAME = CONFIG_FILE_NAME;

export interface WechatNotifyConfigState {
	settings: WechatNotifySettings;
	/** 配置文件绝对路径；未打开工作区时为 undefined */
	configPath: string | undefined;
	/** 配置文件是否已存在。不存在属于正常状态（团队成员未配置） */
	exists: boolean;
}

export function resolveWechatNotifyConfigUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return vscode.Uri.joinPath(folder.uri, ...WECHAT_NOTIFY_CONFIG_RELATIVE_DIR, WECHAT_NOTIFY_CONFIG_FILE_NAME);
}

export async function readWechatNotifyConfigState(): Promise<WechatNotifyConfigState> {
	const uri = resolveWechatNotifyConfigUri();
	if (!uri) {
		return { settings: { ...DEFAULT_WECHAT_NOTIFY_SETTINGS }, configPath: undefined, exists: false };
	}
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder("utf-8").decode(raw);
		return { settings: parseWechatNotifySettings(text), configPath: uri.fsPath, exists: true };
	} catch (error) {
		// 文件不存在是团队成员未配置的正常状态；其他读取错误要留痕，不能静默当成默认值
		const isFileNotFound = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
		if (!isFileNotFound) {
			logger.warn("wechatNotify.config.read", { error: error instanceof Error ? error.message : String(error) });
		}
		return { settings: { ...DEFAULT_WECHAT_NOTIFY_SETTINGS }, configPath: uri.fsPath, exists: false };
	}
}

export async function writeWechatNotifyConfig(
	input: Partial<WechatNotifySettings> | undefined
): Promise<WechatNotifyConfigState> {
	const uri = resolveWechatNotifyConfigUri();
	if (!uri) {
		throw new Error("当前没有打开的工作区，无法写入企微联动配置。");
	}
	const settings = sanitizeWechatNotifySettings(input);
	const body = serializeWechatNotifySettings(settings);
	// 带 UTF-8 BOM：Windows PowerShell 读无 BOM 文件会按 ANSI 解码，中文注释会乱码
	const payload = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
	await vscode.workspace.fs.writeFile(uri, payload);
	return { settings, configPath: uri.fsPath, exists: true };
}
