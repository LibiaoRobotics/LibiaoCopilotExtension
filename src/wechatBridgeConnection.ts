/**
 * 企微智能机器人长连接（WebSocket）维护。
 *
 * 用 `ws` 而不是全局 WebSocket：实测 VS Code 扩展宿主的全局 WebSocket（undici）
 * 连企微网关必然 1006 关闭，而 ws 可以正常握手（DNS/TLS/Upgrade 均已逐项排除）。
 */
import WebSocket from "ws";
import { logger } from "./logger";
import {
	buildPingRequest,
	buildSubscribeRequest,
	createBridgeReqId,
	extractInboundEventType,
	parseBridgeFrame,
	parseBridgeResponse,
	WECHAT_BRIDGE_GATEWAY_URL,
	WECHAT_BRIDGE_PING_INTERVAL_MS,
	type WechatBridgeFrame,
	type WechatBridgeResponse,
} from "./wechatBridgeProtocol";

export type WechatBridgeConnectionState = "idle" | "connecting" | "subscribed" | "failed" | "kicked" | "closed";

export interface WechatBridgeConnectionHandlers {
	/** 非响应帧（消息回调、事件回调）交由上层处理 */
	onFrame(frame: WechatBridgeFrame): void;
	onStateChange(state: WechatBridgeConnectionState, detail?: string): void;
	/** 服务端主动断开的事件回调，例如被其他连接顶掉 */
	onDisconnectedEvent(): void;
	/** 订阅之外的有 request/response 请求（如主动推送）的响应，用于判断是否真的送达 */
	onResponse?(response: WechatBridgeResponse): void;
}

/** 重连退避：第一次很快重试，之后逐步拉长，避免把网关打成拒绝服务 */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

function rawDataToText(data: WebSocket.RawData): string | undefined {
	if (typeof data === "string") {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString("utf8");
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString("utf8");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	return undefined;
}

export class WechatBridgeConnection {
	private socket: WebSocket | undefined;
	private pingTimer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private subscribeReqId: string | undefined;
	private attempt = 0;
	private stateValue: WechatBridgeConnectionState = "idle";
	private detailValue = "";
	private disposed = false;
	/** 被其他连接顶掉后不再自动重连，否则会和新连接互踢 */
	private kicked = false;

	constructor(
		private readonly botId: string,
		private readonly secret: string,
		private readonly handlers: WechatBridgeConnectionHandlers
	) {}

	get state(): WechatBridgeConnectionState {
		return this.stateValue;
	}

	get detail(): string {
		return this.detailValue;
	}

	get isSubscribed(): boolean {
		return this.stateValue === "subscribed";
	}

	connect(): void {
		if (this.disposed || this.kicked) {
			return;
		}
		if (this.socket && (this.stateValue === "connecting" || this.stateValue === "subscribed")) {
			return;
		}
		this.clearReconnectTimer();
		this.setState("connecting", this.attempt > 0 ? `第 ${this.attempt + 1} 次尝试` : "");

		let socket: WebSocket;
		try {
			socket = new WebSocket(WECHAT_BRIDGE_GATEWAY_URL, { handshakeTimeout: 15_000 });
		} catch (error) {
			this.handleFailure(error instanceof Error ? error.message : String(error));
			return;
		}
		this.socket = socket;

		socket.on("open", () => {
			logger.info("wechat-bridge", { event: "socket-open" });
			this.subscribe(socket);
		});
		socket.on("message", (data: WebSocket.RawData) => {
			const text = rawDataToText(data);
			if (text) {
				this.handleMessage(socket, text);
			}
		});
		socket.on("error", (error: Error) => {
			logger.warn("wechat-bridge", { event: "socket-error", message: error.message });
			// close 事件随后一定会来，重连逻辑统一放在 close 里
			this.detailValue = error.message;
		});
		socket.on("close", (code: number, reason: Buffer) => {
			const reasonText = reason.toString("utf8");
			logger.warn("wechat-bridge", { event: "socket-close", code, reason: reasonText });
			this.stopPing();
			if (this.socket === socket) {
				this.socket = undefined;
			}
			if (this.disposed || this.kicked) {
				return;
			}
			const detail = this.detailValue || `连接已断开（${code}${reasonText ? ` ${reasonText}` : ""}）`;
			this.setState("closed", detail);
			this.scheduleReconnect();
		});
	}

	disconnect(): void {
		this.disposed = true;
		this.clearReconnectTimer();
		this.stopPing();
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			try {
				socket.removeAllListeners();
				socket.close();
			} catch {
				// 关不掉就让它自己超时
			}
		}
		this.setState("idle");
	}

	/** 被别的连接顶掉：停止一切自动重连 */
	markKicked(detail: string): void {
		this.kicked = true;
		this.clearReconnectTimer();
		this.stopPing();
		this.setState("kicked", detail);
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			try {
				socket.removeAllListeners();
				socket.close();
			} catch {
				// 同上
			}
		}
	}

	send(payload: string): boolean {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return false;
		}
		try {
			socket.send(payload);
			return true;
		} catch (error) {
			logger.warn("wechat-bridge", {
				event: "send-failed",
				message: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	private subscribe(socket: WebSocket): void {
		const reqId = createBridgeReqId();
		this.subscribeReqId = reqId;
		const payload = buildSubscribeRequest(this.botId, this.secret, reqId);
		try {
			socket.send(payload);
		} catch (error) {
			this.handleFailure(error instanceof Error ? error.message : String(error));
		}
	}

	private handleMessage(socket: WebSocket, text: string): void {
		const frame = parseBridgeFrame(text);
		if (!frame) {
			logger.debug("wechat-bridge", { event: "frame-unparsable", length: text.length });
			return;
		}
		const response = parseBridgeResponse(frame);
		if (response) {
			if (response.reqId && response.reqId === this.subscribeReqId) {
				if (response.errcode === 0) {
					this.attempt = 0;
					this.setState("subscribed");
					this.startPing(socket);
					logger.info("wechat-bridge", { event: "subscribed" });
				} else {
					this.handleFailure(`订阅被拒绝：${response.errcode} ${response.errmsg}`);
				}
				return;
			}
			if (response.errcode !== 0) {
				logger.warn("wechat-bridge", {
					event: "response-error",
					reqId: response.reqId,
					errcode: response.errcode,
					errmsg: response.errmsg,
				});
			}
			this.handlers.onResponse?.(response);
			return;
		}
		if (frame.cmd) {
			if (frame.cmd === "aibot_event_callback" && this.isDisconnectedEvent(frame)) {
				this.handlers.onDisconnectedEvent();
				this.markKicked("该机器人已被其他连接接管");
				return;
			}
			this.handlers.onFrame(frame);
		}
	}

	/**
	 * 事件类型实际在 body.event.eventtype 下。
	 * 早期实现查的是 body.disconnected_event，永远命中不了，导致被顶掉时不停止重连。
	 */
	private isDisconnectedEvent(frame: WechatBridgeFrame): boolean {
		return extractInboundEventType(frame) === "disconnected_event";
	}

	private startPing(socket: WebSocket): void {
		this.stopPing();
		this.pingTimer = setInterval(() => {
			if (!this.send(buildPingRequest(createBridgeReqId()))) {
				logger.warn("wechat-bridge", { event: "ping-failed", readyState: socket.readyState });
			}
		}, WECHAT_BRIDGE_PING_INTERVAL_MS);
		this.pingTimer.unref?.();
	}

	private stopPing(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer();
		const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	/** 连接层面的致命错误：关掉 socket，让 close 事件走重连流程 */
	private handleFailure(detail: string): void {
		this.setState("failed", detail);
		const socket = this.socket;
		this.socket = undefined;
		this.stopPing();
		if (socket) {
			try {
				socket.removeAllListeners("close");
				socket.close();
			} catch {
				// 忽略
			}
		}
		if (!this.disposed && !this.kicked) {
			this.scheduleReconnect();
		}
	}

	private setState(state: WechatBridgeConnectionState, detail = ""): void {
		if (this.stateValue === state && this.detailValue === detail) {
			return;
		}
		this.stateValue = state;
		this.detailValue = detail;
		this.handlers.onStateChange(state, detail);
	}
}
