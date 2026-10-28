/**
 * 企微联动可调参数（.github/hooks/WechatNotify.local.psd1）的解析与序列化。
 *
 * 这里刻意不 import vscode：面板、状态栏与验证脚本共用同一份实现，
 * 纯字符串逻辑才能脱离扩展宿主直接跑行为验证。
 */

export interface WechatNotifySettings {
	enabled: boolean;
	webhook: string;
	minDurationSeconds: number;
	sessionSummaryChars: number;
}

/** 必须与 WechatNotify.ps1 顶部的默认值一致：默认关闭，缺文件时不会误发通知 */
export const DEFAULT_WECHAT_NOTIFY_SETTINGS: WechatNotifySettings = {
	enabled: false,
	webhook: "",
	minDurationSeconds: 30,
	sessionSummaryChars: 60,
};

/** 与 hook 侧取值语义对齐的合法区间 */
export const WECHAT_NOTIFY_LIMITS = {
	minDurationSeconds: { min: 0, max: 86400 },
	sessionSummaryChars: { min: 1, max: 2000 },
} as const;

/**
 * 剥离 psd1 注释：引号外的 `#` 到行尾、`<# ... #>` 块注释。
 * 不能简单用正则，否则 webhook 里的 `#` 会被误当注释起点。
 */
function stripComments(text: string): string {
	let output = "";
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote !== null) {
			output += ch;
			if (ch === quote) {
				// psd1 里连续两个引号表示引号本身，不结束字符串
				if (text[i + 1] === quote) {
					output += quote;
					i++;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			output += ch;
			continue;
		}
		if (ch === "<" && text[i + 1] === "#") {
			const end = text.indexOf("#>", i + 2);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (ch === "#") {
			while (i < text.length && text[i] !== "\n") {
				i++;
			}
			output += "\n";
			continue;
		}
		output += ch;
	}
	return output;
}

/** 取 `Key = <原始值>` 中 `=` 之后、行尾或 `;` 之前的内容 */
function readRawValue(text: string, key: string): string | undefined {
	const match = new RegExp(`(?:^|[\\s{;])${key}\\s*=\\s*([^;\\r\\n]*)`, "i").exec(text);
	return match ? match[1].trim() : undefined;
}

/** 去引号并还原转义的引号；未闭合时返回已读到的内容 */
function unquote(raw: string): string {
	const quote = raw[0];
	if (quote !== "'" && quote !== '"') {
		return raw;
	}
	let value = "";
	for (let i = 1; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === quote) {
			if (raw[i + 1] === quote) {
				value += quote;
				i++;
				continue;
			}
			return value;
		}
		value += ch;
	}
	return value;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	// 只匹配值的开头：一行写法 `@{ Enabled = $true }` 尾部还带着 `}`
	const match = /^\$(true|false)\b/i.exec(raw.trim());
	return match ? match[1].toLowerCase() === "true" : undefined;
}

function parseInteger(raw: string | undefined, limits: { min: number; max: number }): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const text = /^['"]/.test(raw) ? unquote(raw) : raw;
	const match = /^-?\d+/.exec(text.trim());
	if (!match) {
		return undefined;
	}
	return clamp(Number.parseInt(match[0], 10), limits);
}

function clamp(value: number, limits: { min: number; max: number }): number {
	return Math.min(limits.max, Math.max(limits.min, Math.trunc(value)));
}

/**
 * 解析 psd1 文本。缺失或无法识别的键回落到默认值，
 * 与 WechatNotify.ps1 里 `ContainsKey` 逐键守卫的降级行为保持一致。
 */
export function parseWechatNotifySettings(text: string): WechatNotifySettings {
	const body = stripComments(text);
	const enabled = parseBoolean(readRawValue(body, "Enabled"));
	const webhook = readRawValue(body, "Webhook");
	const minDurationSeconds = parseInteger(readRawValue(body, "MinDurationSeconds"), WECHAT_NOTIFY_LIMITS.minDurationSeconds);
	const sessionSummaryChars = parseInteger(
		readRawValue(body, "SessionSummaryChars"),
		WECHAT_NOTIFY_LIMITS.sessionSummaryChars
	);
	return {
		enabled: enabled ?? DEFAULT_WECHAT_NOTIFY_SETTINGS.enabled,
		webhook: webhook === undefined ? DEFAULT_WECHAT_NOTIFY_SETTINGS.webhook : unquote(webhook),
		minDurationSeconds: minDurationSeconds ?? DEFAULT_WECHAT_NOTIFY_SETTINGS.minDurationSeconds,
		sessionSummaryChars: sessionSummaryChars ?? DEFAULT_WECHAT_NOTIFY_SETTINGS.sessionSummaryChars,
	};
}

/**
 * 序列化为 psd1 文本。
 * 格式固定为一行一个键，因此写出的文件必然能被本模块与
 * `Import-PowerShellDataFile` 正确读回。
 */
export function serializeWechatNotifySettings(settings: WechatNotifySettings): string {
	const escapedWebhook = settings.webhook.replace(/'/g, "''");
	return [
		"# 企微联动可调参数。由 Libiao Copilot 的「企微联动」配置界面维护，保存会重写本文件。",
		"# 本文件被 .gitignore 排除，请勿提交。",
		"@{",
		`\tEnabled             = $${settings.enabled ? "true" : "false"}`,
		`\tWebhook             = '${escapedWebhook}'`,
		`\tMinDurationSeconds  = ${clamp(settings.minDurationSeconds, WECHAT_NOTIFY_LIMITS.minDurationSeconds)}`,
		`\tSessionSummaryChars = ${clamp(settings.sessionSummaryChars, WECHAT_NOTIFY_LIMITS.sessionSummaryChars)}`,
		"}",
		"",
	].join("\n");
}

/** 把界面传来的任意输入规整成合法设置，非法值回落默认 */
export function sanitizeWechatNotifySettings(input: Partial<WechatNotifySettings> | undefined): WechatNotifySettings {
	const source = input ?? {};
	const enabled = typeof source.enabled === "boolean" ? source.enabled : DEFAULT_WECHAT_NOTIFY_SETTINGS.enabled;
	const webhook = typeof source.webhook === "string" ? source.webhook.trim() : DEFAULT_WECHAT_NOTIFY_SETTINGS.webhook;
	const minDurationSeconds =
		typeof source.minDurationSeconds === "number" && Number.isFinite(source.minDurationSeconds)
			? clamp(source.minDurationSeconds, WECHAT_NOTIFY_LIMITS.minDurationSeconds)
			: DEFAULT_WECHAT_NOTIFY_SETTINGS.minDurationSeconds;
	const sessionSummaryChars =
		typeof source.sessionSummaryChars === "number" && Number.isFinite(source.sessionSummaryChars)
			? clamp(source.sessionSummaryChars, WECHAT_NOTIFY_LIMITS.sessionSummaryChars)
			: DEFAULT_WECHAT_NOTIFY_SETTINGS.sessionSummaryChars;
	return { enabled, webhook, minDurationSeconds, sessionSummaryChars };
}
