import * as vscode from "vscode";
import { logger } from "./logger";
import { getPowerShellStatus, parsePowerShellVersion } from "./powershellManager";
import { writeWechatNotifyConfig } from "./wechatNotifyConfig";
import {
	describePowerShellRequirement,
	evaluateWechatNotifyScript,
	evaluateWechatNotifySetup,
	mergeWechatNotifyHookJson,
	type WechatNotifyHookPresence,
	type WechatNotifyPowerShellInfo,
	type WechatNotifyScriptInfo,
	type WechatNotifySetupState,
} from "./wechatNotifyHookSetup";
import {
	WECHAT_NOTIFY_CONFIG_FILE_NAME,
	WECHAT_NOTIFY_HOOK_DIR,
	WECHAT_NOTIFY_JSON_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_FILE_NAME,
} from "./wechatNotifyPaths";
import type { WechatNotifySettings } from "./wechatNotifySettings";

/** 扩展内置的 hook 模板目录：.vscodeignore 排除了 .github/**，模板只能放在 assets 下 */
export const WECHAT_NOTIFY_TEMPLATE_DIR = ["assets", "hooks"] as const;

/** pwsh 探测要 spawn 进程，未安装时会吃满 3 秒超时，必须缓存 */
const POWER_SHELL_CACHE_MS = 60_000;
let powerShellCache: WechatNotifyPowerShellInfo | undefined;

export interface WechatNotifyCreateResult {
	created: string[];
	skipped: string[];
}

export interface WechatNotifyUpdateResult {
	/** 覆盖前的备份文件绝对路径；内容与模板一致时为空 */
	backupPath?: string;
	previousVersion: string;
	templateVersion: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveHookDirUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return vscode.Uri.joinPath(folder.uri, ...WECHAT_NOTIFY_HOOK_DIR);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		// 不存在属于正常状态；其他 IO 错误要留痕，不能当成"没创建"
		const isFileNotFound = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
		if (!isFileNotFound) {
			logger.warn("wechatNotify.hook.stat", { path: uri.fsPath, error: describeError(error) });
		}
		return false;
	}
}

async function readTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder("utf-8").decode(raw);
	} catch (error) {
		const isFileNotFound = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
		if (!isFileNotFound) {
			logger.warn("wechatNotify.hook.read", { path: uri.fsPath, error: describeError(error) });
		}
		return undefined;
	}
}

export async function readWechatNotifyHookPresence(): Promise<WechatNotifyHookPresence> {
	const dir = resolveHookDirUri();
	if (!dir) {
		return { json: false, script: false, config: false };
	}
	const [json, script, config] = await Promise.all([
		fileExists(vscode.Uri.joinPath(dir, WECHAT_NOTIFY_JSON_FILE_NAME)),
		fileExists(vscode.Uri.joinPath(dir, WECHAT_NOTIFY_SCRIPT_FILE_NAME)),
		fileExists(vscode.Uri.joinPath(dir, WECHAT_NOTIFY_CONFIG_FILE_NAME)),
	]);
	return { json, script, config };
}

function resolveTemplateScriptUri(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, ...WECHAT_NOTIFY_TEMPLATE_DIR, WECHAT_NOTIFY_SCRIPT_FILE_NAME);
}

/**
 * 模板文本缓存。扩展升级必须重载窗口，进程内模板不会变；
 * 状态栏刷新频率高，每次都读 10KB 属于浪费。
 */
let templateScriptCache: string | undefined;

async function readTemplateScript(extensionUri: vscode.Uri): Promise<string | undefined> {
	if (templateScriptCache !== undefined) {
		return templateScriptCache;
	}
	const text = await readTextIfExists(resolveTemplateScriptUri(extensionUri));
	if (text !== undefined) {
		templateScriptCache = text;
	}
	return text;
}

/** 读工作区脚本并和内置模板比对版本；不涉及 pwsh 探测，状态栏可以直接调 */
export async function readWechatNotifyScriptInfo(extensionUri: vscode.Uri): Promise<WechatNotifyScriptInfo> {
	const dir = resolveHookDirUri();
	const templateText = await readTemplateScript(extensionUri);
	const installedText = dir
		? await readTextIfExists(vscode.Uri.joinPath(dir, WECHAT_NOTIFY_SCRIPT_FILE_NAME))
		: undefined;
	return evaluateWechatNotifyScript(installedText, templateText);
}

function readMajorVersion(version: string): number {
	const text = parsePowerShellVersion(version) ?? version.trim();
	const major = Number.parseInt(text.split(".")[0], 10);
	return Number.isNaN(major) ? 0 : major;
}

async function detectPowerShellInfo(): Promise<WechatNotifyPowerShellInfo> {
	const status = await getPowerShellStatus();
	// getPowerShellStatus 把超时、spawn 失败、真未安装都归为 installed=false，
	// 因此 detail 必须说明"可能未装也可能在非标准路径"，不能断言未安装
	const ok = status.installed && readMajorVersion(status.version) >= 7;
	return {
		ok,
		installed: status.installed,
		version: status.version,
		executablePath: status.executablePath,
		detail: ok ? "" : describePowerShellRequirement(status.installed, status.version),
		checkedAt: Date.now(),
	};
}

export async function getWechatNotifyPowerShellInfo(force = false): Promise<WechatNotifyPowerShellInfo> {
	if (!force && powerShellCache && Date.now() - powerShellCache.checkedAt < POWER_SHELL_CACHE_MS) {
		return powerShellCache;
	}
	try {
		powerShellCache = await detectPowerShellInfo();
	} catch (error) {
		logger.warn("wechatNotify.powershell.detect", { error: describeError(error) });
		powerShellCache = {
			ok: false,
			installed: false,
			version: "",
			executablePath: "",
			detail: describePowerShellRequirement(false, ""),
			checkedAt: Date.now(),
		};
	}
	return powerShellCache;
}

export async function readWechatNotifySetupState(
	extensionUri: vscode.Uri,
	forcePowerShell = false
): Promise<WechatNotifySetupState> {
	const workspaceReady = Boolean(vscode.workspace.workspaceFolders?.length);
	const [presence, powershell, script] = await Promise.all([
		readWechatNotifyHookPresence(),
		getWechatNotifyPowerShellInfo(forcePowerShell),
		readWechatNotifyScriptInfo(extensionUri),
	]);
	return evaluateWechatNotifySetup({
		presence,
		workspaceReady,
		hookDirPath: resolveHookDirUri()?.fsPath,
		powershell,
		script,
	});
}

/**
 * 在 .github/hooks 下创建三件套。
 *
 * 逐文件幂等：已存在的文件一律跳过并回报，绝不覆盖——psd1 存着用户真实
 * webhook，ps1 可能被改过，静默重写等于毁配置。
 */
export async function createWechatNotifyHook(
	extensionUri: vscode.Uri,
	settings: Partial<WechatNotifySettings> | undefined
): Promise<WechatNotifyCreateResult> {
	let setup = await readWechatNotifySetupState(extensionUri);
	if (!setup.canModify && setup.workspaceReady) {
		// 用户可能刚装完 pwsh，创建前强制复检一次，避免被 60 秒缓存误拦
		setup = await readWechatNotifySetupState(extensionUri, true);
	}
	if (!setup.canModify) {
		throw new Error(setup.message);
	}

	const dir = resolveHookDirUri();
	if (!dir) {
		throw new Error("当前没有打开的工作区，无法创建企微联动 hook。");
	}
	await vscode.workspace.fs.createDirectory(dir);

	const created: string[] = [];
	const skipped: string[] = [];

	// 1. 脚本：模板按字节复制，保住 UTF-8 BOM 与中文注释
	const scriptUri = vscode.Uri.joinPath(dir, WECHAT_NOTIFY_SCRIPT_FILE_NAME);
	if (await fileExists(scriptUri)) {
		skipped.push(WECHAT_NOTIFY_SCRIPT_FILE_NAME);
	} else {
		const templateUri = resolveTemplateScriptUri(extensionUri);
		let template: Uint8Array;
		try {
			template = await vscode.workspace.fs.readFile(templateUri);
		} catch (error) {
			logger.warn("wechatNotify.hook.template", { path: templateUri.fsPath, error: describeError(error) });
			throw new Error(`扩展内置模板 ${WECHAT_NOTIFY_SCRIPT_FILE_NAME} 缺失，无法创建 hook，请重装扩展。`);
		}
		await vscode.workspace.fs.writeFile(scriptUri, template);
		created.push(WECHAT_NOTIFY_SCRIPT_FILE_NAME);
	}

	// 2. 注册文件：读-改-写只追加 Stop 条目，解析失败就停下，不用新内容覆盖
	const jsonUri = vscode.Uri.joinPath(dir, WECHAT_NOTIFY_JSON_FILE_NAME);
	const merged = mergeWechatNotifyHookJson(await readTextIfExists(jsonUri));
	if (merged.kind === "invalid") {
		throw new Error(
			`${WECHAT_NOTIFY_JSON_FILE_NAME} 不是可解析的 hook 配置（${merged.error}），已保持原样。请先修复或删除该文件后重试。`
		);
	}
	if (merged.kind === "unchanged") {
		skipped.push(WECHAT_NOTIFY_JSON_FILE_NAME);
	} else {
		await vscode.workspace.fs.writeFile(jsonUri, new TextEncoder().encode(merged.text));
		created.push(WECHAT_NOTIFY_JSON_FILE_NAME);
	}

	// 3. 本地参数：已存在就跳过，用户的 webhook 不能被面板默认值冲掉
	const configUri = vscode.Uri.joinPath(dir, WECHAT_NOTIFY_CONFIG_FILE_NAME);
	if (await fileExists(configUri)) {
		skipped.push(WECHAT_NOTIFY_CONFIG_FILE_NAME);
	} else {
		await writeWechatNotifyConfig(settings);
		created.push(WECHAT_NOTIFY_CONFIG_FILE_NAME);
	}

	return { created, skipped };
}

/** 备份文件名：同一秒内多次更新时追加序号，绝不覆盖已有备份 */
async function createBackupUri(dir: vscode.Uri, baseName: string): Promise<vscode.Uri> {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	for (let index = 1; index <= 20; index += 1) {
		const suffix = index === 1 ? "" : `-${index}`;
		const uri = vscode.Uri.joinPath(dir, `${baseName}.bak-${stamp}${suffix}`);
		if (!(await fileExists(uri))) {
			return uri;
		}
	}
	throw new Error("无法生成备份文件名，请清理 .github/hooks 下的历史备份后重试。");
}

/**
 * 用内置模板覆盖工作区脚本。
 *
 * 用户改脚本是常态，覆盖前一律先备份；模板读不到就中止，
 * 绝不把脚本写成空文件（那会让 Stop hook 静默失效）。
 */
export async function updateWechatNotifyScript(extensionUri: vscode.Uri): Promise<WechatNotifyUpdateResult> {
	const dir = resolveHookDirUri();
	if (!dir) {
		throw new Error("当前没有打开的工作区，无法更新企微联动 hook。");
	}
	const scriptUri = vscode.Uri.joinPath(dir, WECHAT_NOTIFY_SCRIPT_FILE_NAME);
	let installedBytes: Uint8Array;
	try {
		installedBytes = await vscode.workspace.fs.readFile(scriptUri);
	} catch (error) {
		const isFileNotFound = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
		if (!isFileNotFound) {
			logger.warn("wechatNotify.hook.read", { path: scriptUri.fsPath, error: describeError(error) });
		}
		throw new Error(`${WECHAT_NOTIFY_SCRIPT_FILE_NAME} 尚未创建，请先点「初始化到此项目」。`);
	}
	const installedText = new TextDecoder("utf-8").decode(installedBytes);

	const templateUri = resolveTemplateScriptUri(extensionUri);
	let template: Uint8Array;
	try {
		template = await vscode.workspace.fs.readFile(templateUri);
	} catch (error) {
		logger.warn("wechatNotify.hook.template", { path: templateUri.fsPath, error: describeError(error) });
		throw new Error(`扩展内置模板 ${WECHAT_NOTIFY_SCRIPT_FILE_NAME} 缺失，无法更新，请重装扩展。`);
	}

	const before = evaluateWechatNotifyScript(installedText, new TextDecoder("utf-8").decode(template));
	const result: WechatNotifyUpdateResult = {
		previousVersion: before.installedVersion,
		templateVersion: before.templateVersion,
	};
	if (!before.identical) {
		const backupUri = await createBackupUri(dir, WECHAT_NOTIFY_SCRIPT_FILE_NAME);
		// 按原始字节备份，BOM 与换行都保持原样
		await vscode.workspace.fs.writeFile(backupUri, installedBytes);
		result.backupPath = backupUri.fsPath;
	}
	// 按模板字节写出，保住 UTF-8 BOM
	await vscode.workspace.fs.writeFile(scriptUri, template);
	return result;
}
