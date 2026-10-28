import {
	WECHAT_NOTIFY_CONFIG_FILE_NAME,
	WECHAT_NOTIFY_JSON_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_RELATIVE_PATH,
} from "./wechatNotifyPaths";

/** hook 注册文件里的 Stop 命令，固定走 pwsh 7 */
export const WECHAT_NOTIFY_HOOK_COMMAND = `pwsh -NoProfile -ExecutionPolicy Bypass -File "${WECHAT_NOTIFY_SCRIPT_RELATIVE_PATH}"`;
export const WECHAT_NOTIFY_HOOK_TIMEOUT_SECONDS = 15;

/** 需要检查与创建的文件（psd1 由面板保存，另外两个来自扩展内置模板） */
export interface WechatNotifyHookPresence {
	json: boolean;
	script: boolean;
	config: boolean;
}

export type WechatNotifyHookFileKey = keyof WechatNotifyHookPresence;

export interface WechatNotifyHookFileItem {
	key: WechatNotifyHookFileKey;
	fileName: string;
	description: string;
	exists: boolean;
}

/** PowerShell 7 探测结果；ok 表示已安装且主版本不低于 7 */
export interface WechatNotifyPowerShellInfo {
	ok: boolean;
	installed: boolean;
	version: string;
	executablePath: string;
	/** ok 为 false 时给用户看的原因 */
	detail: string;
	/** 本结果的检测完成时间戳，面板据此显示"检测于 …" */
	checkedAt: number;
}

export type WechatNotifySetupLevel = "blocked" | "not-created" | "incomplete" | "ready";

/** missing=工作区还没有脚本；unknown=脚本或模板读不到版本号；current=不旧于模板；outdated=可升级 */
export type WechatNotifyScriptUpdateStatus = "missing" | "unknown" | "current" | "outdated";

export interface WechatNotifyScriptInfo {
	status: WechatNotifyScriptUpdateStatus;
	/** 工作区脚本的版本号；"" 表示未声明或读不到 */
	installedVersion: string;
	/** 扩展内置模板的版本号；"" 表示模板缺失或未声明 */
	templateVersion: string;
	/** 与模板是否逐字一致；false 且 status=current 说明用户改过脚本 */
	identical: boolean;
}

export interface WechatNotifySetupState {
	level: WechatNotifySetupLevel;
	workspaceReady: boolean;
	hookDirPath: string | undefined;
	items: WechatNotifyHookFileItem[];
	powershell: WechatNotifyPowerShellInfo;
	script: WechatNotifyScriptInfo;
	/** 保存配置与创建按钮是否可用 */
	canModify: boolean;
	/** 阻断或提示文案；ready 时为空串 */
	message: string;
}

export type WechatNotifyHookMergeResult =
	| { kind: "unchanged"; text: string }
	| { kind: "updated"; text: string }
	| { kind: "invalid"; error: string };

function createWechatNotifyStopEntry(): Record<string, unknown> {
	return {
		type: "command",
		command: WECHAT_NOTIFY_HOOK_COMMAND,
		timeout: WECHAT_NOTIFY_HOOK_TIMEOUT_SECONDS,
	};
}

export function createWechatNotifyHookJson(): string {
	return `${JSON.stringify({ hooks: { Stop: [createWechatNotifyStopEntry()] } }, undefined, 2)}\n`;
}

/** command / windows / linux / osx 都可能承载路径，统一按文件名匹配 */
function mentionsWechatNotifyScript(entry: unknown): boolean {
	const text = JSON.stringify(entry === undefined ? null : entry).toLowerCase();
	return text.includes(WECHAT_NOTIFY_SCRIPT_FILE_NAME.toLowerCase());
}

function readStopEntries(text: string): { stop?: unknown[]; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "顶层不是 JSON 对象" };
	}
	const hooksValue = (parsed as Record<string, unknown>).hooks;
	if (hooksValue === undefined) {
		return {};
	}
	if (typeof hooksValue !== "object" || hooksValue === null || Array.isArray(hooksValue)) {
		return { error: '"hooks" 不是 JSON 对象' };
	}
	const stopValue = (hooksValue as Record<string, unknown>).Stop;
	if (stopValue === undefined) {
		return {};
	}
	if (!Array.isArray(stopValue)) {
		return { error: '"hooks.Stop" 不是数组' };
	}
	return { stop: stopValue };
}

/**
 * 把 Stop 条目并入现有 hook 注册文件。
 *
 * 已存在指向 WechatNotify.ps1 的条目时原样返回（kind=unchanged），
 * 不重排、不重写用户的 json；解析失败返回 invalid，绝不用新内容覆盖。
 */
export function mergeWechatNotifyHookJson(existing: string | undefined): WechatNotifyHookMergeResult {
	const trimmed = (existing ?? "").trim();
	if (!trimmed) {
		return { kind: "updated", text: createWechatNotifyHookJson() };
	}

	const { stop, error } = readStopEntries(trimmed);
	if (error) {
		return { kind: "invalid", error };
	}
	if (stop?.some(mentionsWechatNotifyScript)) {
		return { kind: "unchanged", text: existing ?? trimmed };
	}

	const parsed = JSON.parse(trimmed) as Record<string, unknown>;
	const hooks = (parsed.hooks ?? {}) as Record<string, unknown>;
	hooks.Stop = [...(stop ?? []), createWechatNotifyStopEntry()];
	parsed.hooks = hooks;
	return { kind: "updated", text: `${JSON.stringify(parsed, undefined, 2)}\n` };
}

/** Stop 条目是否已指向 WechatNotify.ps1；解析失败按"没有"处理 */
export function hasWechatNotifyStopHook(text: string | undefined): boolean {
	const trimmed = (text ?? "").trim();
	if (!trimmed) {
		return false;
	}
	const { stop } = readStopEntries(trimmed);
	return Boolean(stop?.some(mentionsWechatNotifyScript));
}

const HOOK_FILE_DESCRIPTIONS: Record<WechatNotifyHookFileKey, { fileName: string; description: string }> = {
	json: { fileName: WECHAT_NOTIFY_JSON_FILE_NAME, description: "hook 注册声明，VS Code 靠它发现 Stop hook" },
	script: { fileName: WECHAT_NOTIFY_SCRIPT_FILE_NAME, description: "通知脚本本体，由扩展内置模板复制" },
	config: { fileName: WECHAT_NOTIFY_CONFIG_FILE_NAME, description: "可调参数与 webhook，不入库、按需由面板生成" },
};

const HOOK_FILE_ORDER: WechatNotifyHookFileKey[] = ["json", "script", "config"];

export function buildWechatNotifyHookFileItems(
	presence: WechatNotifyHookPresence
): WechatNotifyHookFileItem[] {
	return HOOK_FILE_ORDER.map((key) => ({
		key,
		fileName: HOOK_FILE_DESCRIPTIONS[key].fileName,
		description: HOOK_FILE_DESCRIPTIONS[key].description,
		exists: presence[key],
	}));
}

const POWER_SHELL_NOT_FOUND_DETAIL =
	"未检测到 PowerShell 7（pwsh）。可能是尚未安装，或安装在非标准路径——安装后点「重新检测」。";
export function describePowerShellRequirement(installed: boolean, version: string): string {
	if (!installed) {
		return POWER_SHELL_NOT_FOUND_DETAIL;
	}
	return `检测到 PowerShell ${version}，hook 需要 7 或更高版本。`;
}

/** 脚本头部的 `$ScriptVersion = '1.1.0'`；没写或写坏都返回空串 */
export function parseScriptVersion(text: string | undefined): string {
	const match = /^[ \t]*\$ScriptVersion[ \t]*=[ \t]*['"]([^'"]+)['"]/m.exec(text ?? "");
	return match ? match[1].trim() : "";
}

/** 比对前归一化：去 BOM、统一换行、忽略尾部空白，避免编辑器差异被当成"改过脚本" */
function normalizeScriptText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
}

function parseVersionParts(version: string): number[] {
	return version
		.replace(/^v/i, "")
		.split("-")[0]
		.split(".")
		.map((part) => {
			const value = Number.parseInt(part, 10);
			return Number.isNaN(value) ? 0 : value;
		});
}

/** 返回负数表示 a 旧于 b */
function compareScriptVersions(a: string, b: string): number {
	const left = parseVersionParts(a);
	const right = parseVersionParts(b);
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/**
 * 判定工作区脚本是否需要升级。
 *
 * 只比版本号、不比字节：用户改脚本是常态，字节差异不能当作"过时"，
 * 否则每次打开都报警，警告会被无视。identical 只用于提醒"更新会覆盖你的修改"。
 */
export function evaluateWechatNotifyScript(
	installedText: string | undefined,
	templateText: string | undefined
): WechatNotifyScriptInfo {
	const templateVersion = parseScriptVersion(templateText);
	if (installedText === undefined) {
		return { status: "missing", installedVersion: "", templateVersion, identical: false };
	}
	const installedVersion = parseScriptVersion(installedText);
	const identical =
		templateText !== undefined &&
		normalizeScriptText(installedText) === normalizeScriptText(templateText);
	if (!installedVersion || !templateVersion) {
		return { status: "unknown", installedVersion, templateVersion, identical };
	}
	const status: WechatNotifyScriptUpdateStatus =
		compareScriptVersions(installedVersion, templateVersion) < 0 ? "outdated" : "current";
	return { status, installedVersion, templateVersion, identical };
}

/**
 * 汇总环境就绪度。
 *
 * 没有 PowerShell 7 时整体不可修改：psd1 存了也发不出通知，
 * 允许保存只会制造"配好了但不生效"的假象。
 */
export function evaluateWechatNotifySetup(input: {
	presence: WechatNotifyHookPresence;
	workspaceReady: boolean;
	hookDirPath: string | undefined;
	powershell: WechatNotifyPowerShellInfo;
	script: WechatNotifyScriptInfo;
}): WechatNotifySetupState {
	const items = buildWechatNotifyHookFileItems(input.presence);
	const base = {
		workspaceReady: input.workspaceReady,
		hookDirPath: input.hookDirPath,
		items,
		powershell: input.powershell,
		script: input.script,
	};

	if (!input.workspaceReady) {
		return {
			...base,
			level: "blocked",
			canModify: false,
			message: '当前没有打开的工作区，无法定位 .github/hooks 目录。',
		};
	}
	if (!input.powershell.ok) {
		return { ...base, level: "blocked", canModify: false, message: input.powershell.detail };
	}

	const hookReady = input.presence.json && input.presence.script;
	if (hookReady) {
		return { ...base, level: "ready", canModify: true, message: "" };
	}

	const missing = items
		.filter((item) => item.key !== "config" && !item.exists)
		.map((item) => item.fileName);
	const message = missing.length >= 2
		? `当前项目尚未创建企微联动 hook（缺少 ${missing.join("、")}），点击「初始化到此项目」生成。`
		: `缺少 ${missing.join("、")}，通知不会触发。点击「初始化到此项目」补齐。`;

	return {
		...base,
		level: missing.length >= 2 ? "not-created" : "incomplete",
		canModify: true,
		message,
	};
}

/**
 * 状态栏主状态，互斥。"待升级"不在此列 —— 它是叠加在 active / disabled 之上的标记：
 * 待升级时脚本仍在正常发通知，主图标必须继续回答"现在到底在不在发"。
 */
export type WechatNotifyStatus =
	| "no-workspace"
	| "not-created"
	| "incomplete"
	| "no-webhook"
	| "disabled"
	| "active";

/**
 * 判定状态栏主状态。
 *
 * not-created 与 incomplete 必须分开：前者是还没开始用，后者是文件坏了要修。
 * 两者共用 $(warning) 会让真正的故障失去信号。
 */
export function resolveWechatNotifyStatus(input: {
	workspaceReady: boolean;
	presence: WechatNotifyHookPresence;
	enabled: boolean;
	webhook: string;
}): WechatNotifyStatus {
	if (!input.workspaceReady) {
		return "no-workspace";
	}
	const { json, script } = input.presence;
	if (!json && !script) {
		return "not-created";
	}
	if (!json || !script) {
		return "incomplete";
	}
	if (!input.enabled) {
		return "disabled";
	}
	// 勾了启用却没填 webhook：意图与实际行为相反，必须报警而不是静默当成"已启用"
	return input.webhook.trim().length > 0 ? "active" : "no-webhook";
}
