/**
 * 企业微信群消息推送模块连通性测试。
 *
 * 只在面板点按钮时跑一次，不进 hook 链路，也不读写 psd1。
 * 单独成文件是为了能脱离扩展宿主直接跑真实 HTTP 验证。
 */
import { logger } from "./logger";

export const WECHAT_NOTIFY_TEST_TIMEOUT_MS = 10_000;

export interface WechatNotifyTestResult {
	ok: boolean;
	/** 可直接展示给用户的结论，失败时说明原因 */
	detail: string;
	/** 推送模块返回的 errcode；没拿到响应时为 undefined */
	errcode?: number;
	/** 从发起到拿到响应的毫秒数 */
	elapsedMs: number;
}

export type WechatNotifyWebhookCheck = { ok: true; url: string } | { ok: false; reason: string };

/** 常见 errcode 的白话解释；未收录的回落成企微自带的 errmsg */
const WECHAT_ERRCODE_HINTS: Record<number, string> = {
	40001: "key 无效或已被重置",
	40058: "请求参数不合法",
	45009: "调用过于频繁，被企业微信限流",
	93000: "Webhook 地址无效，推送模块可能已被移出群聊或 key 已失效",
};

const MAX_BODY_CHARS = 200;

function truncate(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > MAX_BODY_CHARS ? compact.slice(0, MAX_BODY_CHARS) + "…" : compact;
}

/**
 * 打日志前抹掉 key —— webhook 的 key 就是推送模块凭据，等同于密码，不能落盘。
 */
export function maskWechatNotifyWebhook(raw: string): string {
	return raw.replace(/([?&]key=)[^&\s]*/gi, "$1***");
}

/**
 * 本地时间格式化。不用 toLocaleString：它受系统区域设置影响，输出不稳定。
 */
function formatLocalDateTime(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return `${ymd} ${hms}`;
}

/**
 * 测试正文刻意与真实通知区分：真实通知首行是「⏱️ 本轮对话已结束」，
 * 这里明说是手动测试，避免围观的人以为又结束了一轮。
 */
export function buildWechatNotifyTestContent(now: Date): string {
	return [
		"🔔 企微联动连通性测试",
		"这是从 VS Code 面板手动发出的测试消息，不是对话结束通知。",
		"来源：GitHub Copilot Chat",
		`时间：${formatLocalDateTime(now)}`,
	].join("\n");
}

/**
 * 先在本地挡住最常见的填错，省得为一条明显非法的地址跑一次网络请求。
 * 只校验结构，不校验域名 —— 允许自建转发代理。
 */
export function checkWechatNotifyWebhook(raw: string): WechatNotifyWebhookCheck {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) {
		return { ok: false, reason: "Webhook 地址为空，请先填写企业微信群消息推送模块的 webhook。" };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return {
			ok: false,
			reason: "Webhook 地址不是合法的 URL，应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
		};
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { ok: false, reason: `Webhook 地址的协议是 ${parsed.protocol}，只支持 http 或 https。` };
	}
	if (!parsed.searchParams.get("key")) {
		return { ok: false, reason: "Webhook 地址缺少 key 参数，完整地址应以 ?key=推送模块密钥 结尾。" };
	}
	return { ok: true, url: parsed.toString() };
}

interface WechatApiResponse {
	errcode: number;
	errmsg?: string;
}

function parseWechatApiResponse(text: string): WechatApiResponse | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const errcode = (parsed as Record<string, unknown>).errcode;
	if (typeof errcode !== "number") {
		return undefined;
	}
	const errmsg = (parsed as Record<string, unknown>).errmsg;
	return { errcode, errmsg: typeof errmsg === "string" ? errmsg : undefined };
}

function describeFetchError(error: unknown, timedOut: boolean, timeoutMs: number): string {
	if (timedOut) {
		return `连接超时（${timeoutMs} 毫秒内无响应），请检查网络、代理或防火墙。`;
	}
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = (error as { cause?: { code?: unknown } }).cause;
	const code = typeof cause?.code === "string" ? cause.code : "";
	switch (code) {
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return "域名解析失败，请确认地址中的域名拼写与网络连通性。";
		case "ECONNREFUSED":
			return "连接被拒绝，目标地址没有监听该端口。";
		case "ECONNRESET":
			return "连接被对端重置，可能被代理或防火墙拦截。";
		case "CERT_HAS_EXPIRED":
		case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
		case "SELF_SIGNED_CERT_IN_CHAIN":
			return `TLS 证书校验失败（${code}），检查系统证书或公司代理的中间人证书。`;
		default:
			return code ? `${error.message}（${code}）` : error.message;
	}
}

/**
 * 发一条测试消息并判定是否真的送达。
 *
 * 关键点：企微在 key 失效等情况下依然返回 HTTP 200，只看 response.ok 会把
 * "发不出去"误报成成功，所以必须检查响应体里的 errcode。
 */
export async function sendWechatNotifyTest(
	webhook: string,
	options?: { now?: Date; timeoutMs?: number }
): Promise<WechatNotifyTestResult> {
	const check = checkWechatNotifyWebhook(webhook);
	if (!check.ok) {
		return { ok: false, detail: check.reason, elapsedMs: 0 };
	}

	const timeoutMs = options?.timeoutMs ?? WECHAT_NOTIFY_TEST_TIMEOUT_MS;
	const content = buildWechatNotifyTestContent(options?.now ?? new Date());
	const maskedUrl = maskWechatNotifyWebhook(check.url);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const startedAt = Date.now();
	try {
		const response = await fetch(check.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msgtype: "text", text: { content } }),
			signal: controller.signal,
		});
		const elapsedMs = Date.now() - startedAt;
		const bodyText = await response.text().catch(() => "");

		if (!response.ok) {
			logger.warn("wechatNotify.test", { url: maskedUrl, status: response.status });
			return {
				ok: false,
				detail: `企业微信返回 HTTP ${response.status} ${response.statusText}${bodyText ? `：${truncate(bodyText)}` : ""}`,
				elapsedMs,
			};
		}

		const parsed = parseWechatApiResponse(bodyText);
		if (!parsed) {
			logger.warn("wechatNotify.test", { url: maskedUrl, reason: "unexpected-body" });
			return {
				ok: false,
				detail: `响应不是预期的 JSON：${truncate(bodyText) || "(空响应)"}`,
				elapsedMs,
			};
		}
		if (parsed.errcode !== 0) {
			const hint = WECHAT_ERRCODE_HINTS[parsed.errcode];
			const suffix = hint ? `（${hint}）` : "";
			const raw = parsed.errmsg ? `，errmsg：${parsed.errmsg}` : "";
			logger.warn("wechatNotify.test", { url: maskedUrl, errcode: parsed.errcode });
			return {
				ok: false,
				detail: `企业微信返回 errcode ${parsed.errcode}${suffix}${raw}`,
				errcode: parsed.errcode,
				elapsedMs,
			};
		}

		logger.info("wechatNotify.test", { url: maskedUrl, elapsedMs });
		return { ok: true, detail: `测试消息已送达企业微信，往返 ${elapsedMs} 毫秒。`, errcode: 0, elapsedMs };
	} catch (error) {
		const elapsedMs = Date.now() - startedAt;
		const timedOut = controller.signal.aborted;
		logger.warn("wechatNotify.test", {
			url: maskedUrl,
			timedOut,
			error: error instanceof Error ? error.message : String(error),
		});
		return { ok: false, detail: describeFetchError(error, timedOut, timeoutMs), elapsedMs };
	} finally {
		clearTimeout(timer);
	}
}
