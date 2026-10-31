import {
	WECHAT_INTERACT_SCRIPT_FILE_NAME,
	WECHAT_INTERACT_SCRIPT_RELATIVE_PATH,
	WECHAT_NOTIFY_CONFIG_FILE_NAME,
	WECHAT_NOTIFY_JSON_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_RELATIVE_PATH,
} from "./wechatNotifyPaths";

/** hook 注册文件里的 Stop 命令，固定走 pwsh 7 */
export const WECHAT_NOTIFY_HOOK_COMMAND = `pwsh -NoProfile -ExecutionPolicy Bypass -File "${WECHAT_NOTIFY_SCRIPT_RELATIVE_PATH}"`;
export const WECHAT_NOTIFY_HOOK_TIMEOUT_SECONDS = 15;

/**
 * preToolUse 命令固定走 node：它每个工具调用都要跑一次，冷启动开销直接压在工具延迟上。
 * 实测 pwsh -NoProfile 约 0.33–0.41s，node 约 0.07–0.14s。
 */
export const WECHAT_INTERACT_HOOK_COMMAND = `node "${WECHAT_INTERACT_SCRIPT_RELATIVE_PATH}"`;
export const WECHAT_INTERACT_HOOK_TIMEOUT_SECONDS = 10;

/** 需要检查与创建的文件（psd1 由面板保存，其余来自扩展内置模板） */
export interface WechatNotifyHookPresence {
	json: boolean;
	script: boolean;
	config: boolean;
	/** preToolUse 脚本；缺失时 hook 每次工具调用都会报错，必须参与就绲检测 */
	interact: boolean;
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
	/** 三件套是否齐备；false 时面板只显示介绍与创建按钮 */
	created: boolean;
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

function createWechatInteractEntry(): Record<string, unknown> {
	return {
		type: "command",
		command: WECHAT_INTERACT_HOOK_COMMAND,
		timeout: WECHAT_INTERACT_HOOK_TIMEOUT_SECONDS,
	};
}

/**
 * 需要注册的三类 hook。提问提醒靠 PreToolUse，提问收场靠 PostToolUse，
 * Stop 负责把本轮结果推回群，三者独立存在，所以合并要逐类型补齐，不能“有一类就整体不动”。
 */
const WECHAT_HOOK_KINDS: {
	kind: string;
	create: () => Record<string, unknown>;
	matcher: (entry: unknown) => boolean;
}[] = [
	{ kind: "Stop", create: createWechatNotifyStopEntry, matcher: mentionsWechatNotifyScript },
	{ kind: "PreToolUse", create: createWechatInteractEntry, matcher: mentionsWechatInteractScript },
	{ kind: "PostToolUse", create: createWechatInteractEntry, matcher: mentionsWechatInteractScript },
];

export function createWechatNotifyHookJson(): string {
	const hooks: Record<string, unknown> = {};
	for (const item of WECHAT_HOOK_KINDS) {
		hooks[item.kind] = [item.create()];
	}
	return `${JSON.stringify({ hooks }, undefined, 2)}\n`;
}

/** command / windows / linux / osx 都可能承载路径，统一按文件名匹配 */
function mentionsFile(entry: unknown, fileName: string): boolean {
	const text = JSON.stringify(entry === undefined ? null : entry).toLowerCase();
	return text.includes(fileName.toLowerCase());
}

function mentionsWechatNotifyScript(entry: unknown): boolean {
	return mentionsFile(entry, WECHAT_NOTIFY_SCRIPT_FILE_NAME);
}

function mentionsWechatInteractScript(entry: unknown): boolean {
	return mentionsFile(entry, WECHAT_INTERACT_SCRIPT_FILE_NAME);
}

function readHookEntries(text: string, kind: string): { entries?: unknown[]; error?: string } {
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
	const entries = (hooksValue as Record<string, unknown>)[kind];
	if (entries === undefined) {
		return {};
	}
	if (!Array.isArray(entries)) {
		return { error: `"hooks.${kind}" 不是数组` };
	}
	return { entries };
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

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", error: "顶层不是 JSON 对象" };
	}

	const root = parsed as Record<string, unknown>;
	const hooksValue = root.hooks;
	if (
		hooksValue !== undefined &&
		(typeof hooksValue !== "object" || hooksValue === null || Array.isArray(hooksValue))
	) {
		return { kind: "invalid", error: '"hooks" 不是 JSON 对象' };
	}
	const hooks = (hooksValue ?? {}) as Record<string, unknown>;

	let changed = false;
	for (const item of WECHAT_HOOK_KINDS) {
		const current = hooks[item.kind];
		if (current === undefined) {
			hooks[item.kind] = [item.create()];
			changed = true;
			continue;
		}
		if (!Array.isArray(current)) {
			return { kind: "invalid", error: `"hooks.${item.kind}" 不是数组` };
		}
		if (current.some(item.matcher)) {
			continue;
		}
		current.push(item.create());
		changed = true;
	}

	if (!changed) {
		return { kind: "unchanged", text: existing ?? trimmed };
	}
	root.hooks = hooks;
	return { kind: "updated", text: `${JSON.stringify(root, undefined, 2)}\n` };
}

/** Stop 条目是否已指向 WechatNotify.ps1；解析失败按"没有"处理 */
export function hasWechatNotifyStopHook(text: string | undefined): boolean {
	const trimmed = (text ?? "").trim();
	if (!trimmed) {
		return false;
	}
	const { entries } = readHookEntries(trimmed, "Stop");
	return Boolean(entries?.some(mentionsWechatNotifyScript));
}

const HOOK_FILE_DESCRIPTIONS: Record<WechatNotifyHookFileKey, { fileName: string; description: string }> = {
	json: { fileName: WECHAT_NOTIFY_JSON_FILE_NAME, description: "hook 注册声明，VS Code 靠它发现 Stop 与 PreToolUse hook" },
	script: { fileName: WECHAT_NOTIFY_SCRIPT_FILE_NAME, description: "通知脚本本体，由扩展内置模板复制" },
	interact: {
		fileName: WECHAT_INTERACT_SCRIPT_FILE_NAME,
		description: "提问提醒脚本，把「在等你选择」和「已经答完」写给对话桥接",
	},
	config: { fileName: WECHAT_NOTIFY_CONFIG_FILE_NAME, description: "可调参数与 webhook，不入库、按需由面板生成" },
};

const HOOK_FILE_ORDER: WechatNotifyHookFileKey[] = ["json", "script", "interact", "config"];

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
	"未检测到 PowerShell 7（pwsh）。可能是尚未安装，或安装在非标准路径——装好后重新打开本面板即可复检。";
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
		created:
			input.presence.json && input.presence.script && input.presence.interact && input.presence.config,
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

	const hookReady = input.presence.json && input.presence.script && input.presence.interact;
	if (hookReady) {
		return { ...base, level: "ready", canModify: true, message: "" };
	}

	const missing = items
		.filter((item) => item.key !== "config" && !item.exists)
		.map((item) => item.fileName);
	const message = missing.length >= 2
		? `当前项目尚未创建企微联动 hook（缺少 ${missing.join("、")}），点击「创建企微联动」生成。`
		: `缺少 ${missing.join("、")}，通知不会触发。点击「创建企微联动」补齐。`;

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
	// 没填 webhook 的「启用」等于没启用：hook 里同样会因 Webhook 为空直接退出，
	// 这里若显示成已启用，状态栏就会与实际行为相反。
	if (!input.enabled || input.webhook.trim().length === 0) {
		return "disabled";
	}
	return "active";
}
