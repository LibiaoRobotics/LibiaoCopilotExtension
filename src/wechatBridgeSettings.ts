/**
 * 企微对话（智能机器人长连接）的可调参数。
 *
 * 与「群消息推送」不同，这里的配置是**用户级**的：一个机器人只对应一个人，
 * 不属于某个项目的 hook 文件。因此存 globalState / secrets，不落工作区文件。
 *
 * 刻意不 import vscode：面板、服务与单元测试共用同一份纯逻辑。
 */

/** 注入目标：当前会话（用户正在看的）还是专用会话（首次注入前先新建） */
export type WechatBridgeInjectTarget = "current" | "dedicated";

export interface WechatBridgeSettings {
	enabled: boolean;
	injectTarget: WechatBridgeInjectTarget;
	/** 唯一允许发号施令的企微 userid，留空表示谁都不许（安全默认） */
	allowedUserId: string;
	/** 单轮等待上限，超时后回复"未完成"而不是一直卡住 */
	respondTimeoutSeconds: number;
	/**
	 * 企微发起的轮次是否也推一条群通知。
	 * 默认不推：那一轮的回复已经原路发回企微，再推群就是同一件事通知两遍。
	 * 需要群留痕的人可以在面板上打开。
	 */
	notifyGroupForBridgeTurns: boolean;
}

export const DEFAULT_WECHAT_BRIDGE_SETTINGS: WechatBridgeSettings = {
	enabled: false,
	injectTarget: "current",
	allowedUserId: "",
	respondTimeoutSeconds: 900,
	notifyGroupForBridgeTurns: false,
};

export const WECHAT_BRIDGE_LIMITS = {
	respondTimeoutSeconds: { min: 30, max: 86400 },
} as const;

/**
 * 企微 stream/markdown 消息的 content 上限：20480 字节（UTF-8）。
 * 超出的部分发出去会被整条拒绝，所以必须自己截断。
 */
export const WECHAT_BRIDGE_MESSAGE_MAX_BYTES = 20480;

function clamp(value: number, limits: { min: number; max: number }): number {
	return Math.min(limits.max, Math.max(limits.min, Math.trunc(value)));
}

/** 把界面传来的任意输入规整成合法设置，非法值回落默认 */
export function sanitizeWechatBridgeSettings(
	input: Partial<WechatBridgeSettings> | undefined
): WechatBridgeSettings {
	const source = input ?? {};
	const enabled = typeof source.enabled === "boolean" ? source.enabled : DEFAULT_WECHAT_BRIDGE_SETTINGS.enabled;
	const injectTarget: WechatBridgeInjectTarget =
		source.injectTarget === "dedicated" || source.injectTarget === "current"
			? source.injectTarget
			: DEFAULT_WECHAT_BRIDGE_SETTINGS.injectTarget;
	const allowedUserId =
		typeof source.allowedUserId === "string"
			? source.allowedUserId.trim()
			: DEFAULT_WECHAT_BRIDGE_SETTINGS.allowedUserId;
	const respondTimeoutSeconds =
		typeof source.respondTimeoutSeconds === "number" && Number.isFinite(source.respondTimeoutSeconds)
			? clamp(source.respondTimeoutSeconds, WECHAT_BRIDGE_LIMITS.respondTimeoutSeconds)
			: DEFAULT_WECHAT_BRIDGE_SETTINGS.respondTimeoutSeconds;
	const notifyGroupForBridgeTurns =
		typeof source.notifyGroupForBridgeTurns === "boolean"
			? source.notifyGroupForBridgeTurns
			: DEFAULT_WECHAT_BRIDGE_SETTINGS.notifyGroupForBridgeTurns;
	return { enabled, injectTarget, allowedUserId, respondTimeoutSeconds, notifyGroupForBridgeTurns };
}

/**
 * 按 UTF-8 字节截断，不切碎代理对（emoji 被拦腰切断会变成替换字符）。
 * 边界落在代理对中间时退一个码元。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= maxBytes) {
		return text;
	}
	// 按码点前进而不是按码元回退：回退到代理对中间时，孤立代理项会被编码成 3 字节的替换字符，
	// 反而"看起来没超"。for...of 按码点迭代，emoji 天然不可分割。
	let used = 0;
	let end = 0;
	for (const ch of text) {
		const size = encoder.encode(ch).length;
		if (used + size > maxBytes) {
			break;
		}
		used += size;
		end += ch.length;
	}
	return text.slice(0, end);
}

/**
 * 拼出可发送的正文：先按字节截断，再在末尾标注被截断。
 * 标记本身也占字节，所以先给标记预留空间。
 */
export function fitWechatMessage(text: string, maxBytes = WECHAT_BRIDGE_MESSAGE_MAX_BYTES): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return "";
	}
	const encoder = new TextEncoder();
	if (encoder.encode(trimmed).length <= maxBytes) {
		return trimmed;
	}
	const note = "\n\n…（内容过长已截断，完整结果请在 VS Code 中查看）";
	const room = Math.max(0, maxBytes - encoder.encode(note).length);
	return truncateUtf8(trimmed, room) + note;
}

/**
 * 用于把注入的 prompt 与 chatSessions 里落盘的 message.text 对齐：
 * 用户消息经过界面往返后可能改动空白，逐字符比较会漏判。
 */
export function normalizePromptText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
