/**
 * 企业微信智能机器人「长连接（API 模式）」的帧协议。
 *
 * 依据官方文档（developer.work.weixin.qq.com/document/path/101833/101834/101836，取证实日期 2026-10-31）：
 * - 请求帧 {cmd, headers:{req_id}, body}
 * - 响应帧 {headers:{req_id}, errcode, errmsg}，errcode === 0 为成功
 * - 明文 JSON，无需加解密；回调最多可能因网络原因重复推送，必须按 msgid 排重
 *
 * 全部为纯函数，便于单元测试。
 */
import { randomBytes } from "node:crypto";

export const WECHAT_BRIDGE_GATEWAY_URL = "wss://openws.work.weixin.qq.com";

/** 文档要求每 30 秒发送一次心跳，否则连接会被回收 */
export const WECHAT_BRIDGE_PING_INTERVAL_MS = 30_000;

export const WechatBridgeCmd = {
	subscribe: "aibot_subscribe",
	ping: "ping",
	msgCallback: "aibot_msg_callback",
	eventCallback: "aibot_event_callback",
	respondMsg: "aibot_respond_msg",
	/** 收到模板卡片事件后更新卡片 */
	respondUpdateMsg: "aibot_respond_update_msg",
	/** 没有新消息触发时主动推送 */
	sendMsg: "aibot_send_msg",
} as const;

/** 授权卡片上两个按钮的 key，点击后作为 event_key 回来 */
export const WECHAT_BRIDGE_AUTH_ACCEPT_KEY = "libiao_bridge_auth_accept";
export const WECHAT_BRIDGE_AUTH_REJECT_KEY = "libiao_bridge_auth_reject";
/** 处理完后卡片上残留按钮的 key，点击不再有副作用 */
export const WECHAT_BRIDGE_AUTH_DONE_KEY = "libiao_bridge_auth_done";

/** 合法的事件类型；其余视为未知事件，只记日志 */
export const WECHAT_BRIDGE_EVENT_TYPES = [
	"enter_chat",
	"template_card_event",
	"feedback_event",
	"disconnected_event",
] as const;

export interface WechatBridgeFrame {
	cmd?: string;
	headers?: { req_id?: string };
	body?: unknown;
	errcode?: number;
	errmsg?: string;
}

export interface WechatBridgeResponse {
	reqId?: string;
	errcode: number;
	errmsg: string;
}

/** 从消息回调里提取出的、桥接唯一需要的四个字段 */
export interface WechatInboundMessage {
	msgid: string;
	reqId: string;
	chatType: string;
	userId: string;
	content: string;
}

export function createBridgeReqId(): string {
	return randomBytes(12).toString("hex");
}

/**
 * 授权卡片的 task_id。
 * 文档要求：同一机器人内不可重复，只允许数字、字母和 _-@，最长 128 字节。
 */
export function createAuthorizeTaskId(): string {
	return `libiao-auth-${randomBytes(6).toString("hex")}`;
}

function envelope(cmd: string, reqId: string, body: Record<string, unknown>): string {
	return JSON.stringify({ cmd, headers: { req_id: reqId }, body });
}

export function buildSubscribeRequest(botId: string, secret: string, reqId: string): string {
	return envelope(WechatBridgeCmd.subscribe, reqId, { bot_id: botId, secret });
}

export function buildPingRequest(reqId: string): string {
	return JSON.stringify({ cmd: WechatBridgeCmd.ping, headers: { req_id: reqId } });
}

/**
 * 一条完整（finish=true）的流式回复。
 * content 为全量而非增量，所以只有拿到最终正文时才发一次。
 */
export function buildStreamRespondRequest(reqId: string, streamId: string, content: string): string {
	return envelope(WechatBridgeCmd.respondMsg, reqId, {
		msgtype: "stream",
		stream: { id: streamId, finish: true, content },
	});
}

/**
 * 主动推送一条 markdown 消息（不依附于任何回调，因此没有 req_id 可复用）。
 * aibot_send_msg 不支持 msgtype=stream，只能是终态消息，所以正文必须一次性发完。
 * 前置条件（官方文档 101837）：用户此前给机器人发过消息，否则服务端会拒绝。
 */
export function buildMarkdownSendRequest(reqId: string, userId: string, content: string): string {
	return envelope(WechatBridgeCmd.sendMsg, reqId, {
		chatid: userId,
		chat_type: 1,
		msgtype: "markdown",
		markdown: { content },
	});
}

export interface WechatAuthorizeCardOptions {
	taskId: string;
	/** 单聊主动推送时 chatid 就是用户的 userid */
	userId: string;
	/** 展示用的电脑/工作区名，让用户在企微里能认出是哪台 */
	computerName: string;
	ttlMinutes: number;
}

/** 文档对卡片各字段有长度建议，超了会被截断或整条拒绝，这里统一收口 */
function shorten(value: string, maxChars: number): string {
	const trimmed = value.trim();
	return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

/**
 * 从 VS Code 侧主动发起的授权卡片。
 * 注意 chat_type 必须显式给 1：不填时服务端优先按群聊处理。
 * 前置条件是用户此前给机器人发过消息，否则服务端会拒绝。
 */
export function buildAuthorizeCardRequest(reqId: string, options: WechatAuthorizeCardOptions): string {
	return envelope(WechatBridgeCmd.sendMsg, reqId, {
		chatid: options.userId,
		chat_type: 1,
		msgtype: "template_card",
		template_card: {
			card_type: "button_interaction",
			source: { desc: "Libiao Copilot" },
			main_title: {
				title: "授权这台电脑",
				desc: "企业微信 ↔ VS Code 对话",
			},
			sub_title_text: shorten(
				`点「允许」后，你发给机器人的消息会直接进入 VS Code 里的 Copilot 对话，回复再回到这里。${options.ttlMinutes} 分钟内有效。`,
				112
			),
			horizontal_content_list: [{ keyname: "电脑", value: shorten(options.computerName, 26) }],
			button_list: [
				{ text: "允许", style: 1, key: WECHAT_BRIDGE_AUTH_ACCEPT_KEY },
				{ text: "拒绝", style: 2, key: WECHAT_BRIDGE_AUTH_REJECT_KEY },
			],
			task_id: options.taskId,
		},
	});
}

/**
 * 用户点完按钮后把卡片改成结果态。
 * 必须透传模板卡片事件的 req_id，而且只有 5 秒窗口。
 */
export function buildAuthResultCardRequest(
	reqId: string,
	options: { taskId: string; title: string; desc: string; accepted: boolean }
): string {
	return envelope(WechatBridgeCmd.respondUpdateMsg, reqId, {
		response_type: "update_template_card",
		template_card: {
			card_type: "button_interaction",
			main_title: { title: shorten(options.title, 26), desc: shorten(options.desc, 30) },
			sub_title_text: options.accepted
				? "现在可以在本会话里直接给机器人发消息了。"
				: "本次没有授权，随时可以从 VS Code 面板重新发起。",
			button_list: [{ text: "已处理", style: 1, key: WECHAT_BRIDGE_AUTH_DONE_KEY }],
			task_id: options.taskId,
		},
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 把原始 WebSocket 文本解析成帧；非 JSON 对象一律丢弃 */
export function parseBridgeFrame(raw: unknown): WechatBridgeFrame | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return asRecord(parsed) as WechatBridgeFrame | undefined;
}

/** 响应帧没有 cmd，只带 errcode/errmsg */
export function parseBridgeResponse(frame: WechatBridgeFrame): WechatBridgeResponse | undefined {
	if (frame.cmd || typeof frame.errcode !== "number") {
		return undefined;
	}
	const reqId = asText(asRecord(frame.headers)?.req_id);
	return { reqId, errcode: frame.errcode, errmsg: asText(frame.errmsg) ?? "" };
}

/**
 * 只认「普通用户发的纯文本私聊」。
 * 带 compat_info 表示来自智能助理/频道，不是真人消息，直接忽略。
 */
export function extractInboundTextMessage(frame: WechatBridgeFrame): WechatInboundMessage | undefined {
	if (frame.cmd !== WechatBridgeCmd.msgCallback) {
		return undefined;
	}
	const body = asRecord(frame.body);
	if (!body) {
		return undefined;
	}
	if (body.compat_info !== undefined) {
		return undefined;
	}
	const msgtype = asText(body.msgtype);
	if (msgtype !== "text") {
		return undefined;
	}
	const content = asText(asRecord(body.text)?.content);
	const msgid = asText(body.msgid);
	const reqId = asText(asRecord(frame.headers)?.req_id);
	const userId = asText(asRecord(body.from)?.userid);
	if (!content || !msgid || !reqId || !userId) {
		return undefined;
	}
	return {
		msgid,
		reqId,
		chatType: asText(body.chattype) ?? "",
		userId,
		content,
	};
}

/** 取事件回调的触发者 userid；消息回调与事件回调都带 from.userid */
export function extractInboundUserId(frame: WechatBridgeFrame): string | undefined {
	const body = asRecord(frame.body);
	return asText(asRecord(body?.from)?.userid);
}

/**
 * 取事件回调的类型，用于识别 enter_chat / disconnected_event 等。
 * 文档结构是 body.event.eventtype，事件体在 body.event.<eventtype> 下：
 * 之前按 body.<eventtype> 查找永远匹配不到，导致 disconnected_event 一直没被识别。
 */
export function extractInboundEventType(frame: WechatBridgeFrame): string | undefined {
	if (frame.cmd !== WechatBridgeCmd.eventCallback) {
		return undefined;
	}
	const body = asRecord(frame.body);
	if (!body) {
		return undefined;
	}
	const event = asRecord(body.event);
	const eventtype = asText(event?.eventtype) ?? asText(body.eventtype);
	if (eventtype) {
		return eventtype;
	}
	// 兜底：万一服务端改成把事件体平铺在 body 上
	for (const key of WECHAT_BRIDGE_EVENT_TYPES) {
		if (body[key] !== undefined) {
			return key;
		}
	}
	return undefined;
}

/** 模板卡片事件里桥接需要的字段 */
export interface WechatTemplateCardEvent {
	taskId: string;
	eventKey: string;
	cardType: string;
	userId: string;
	reqId: string;
}

/**
 * 只认模板卡片事件，并且要求 req_id 存在（没有它就没法更新卡片）。
 * task_id 缺失时返回空串，交给上层比对失败，不当作可处理事件。
 */
export function extractTemplateCardEvent(frame: WechatBridgeFrame): WechatTemplateCardEvent | undefined {
	if (extractInboundEventType(frame) !== "template_card_event") {
		return undefined;
	}
	const body = asRecord(frame.body);
	const event = asRecord(body?.event);
	const detail = asRecord(event?.template_card_event);
	const eventKey = asText(detail?.event_key);
	const reqId = asText(asRecord(frame.headers)?.req_id);
	const userId = asText(asRecord(body?.from)?.userid);
	if (!eventKey || !reqId || !userId) {
		return undefined;
	}
	return {
		taskId: asText(detail?.task_id) ?? "",
		eventKey,
		cardType: asText(detail?.card_type) ?? "",
		userId,
		reqId,
	};
}
