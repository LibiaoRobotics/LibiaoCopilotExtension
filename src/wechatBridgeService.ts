/**
 * 企微 ↔ VS Code 对话 的双向桥接服务。
 *
 * 数据流（企微 → VS Code）：
 *   企微用户发消息 → aibot_msg_callback → 白名单/单聊校验 → 串行队列
 *   → 注入到 Copilot Chat（chat.open） → 读 transcript 取本轮正文
 *   → aibot_respond_msg（stream，finish=true）回给企微
 *
 * 数据流（VS Code → 企微）：
 *   任何一轮对话结束（transcripts 里检测到） → 取出正文
 *   → aibot_send_msg（markdown）主动推给已授权的企微用户
 *   注：企微注入的那些轮次不走这条，它们用 aibot_respond_msg 回同一个回调，
 *   否则同一轮会在企微里出现两条。
 *
 * 数据流（等待选择）：
 *   preToolUse hook（.github/hooks/WechatInteract.js）把提问参数落到 wechatPending sidecar
 *   → InteractionInbox 增量读取 → 渲染成一条提醒 → aibot_send_msg 推给已授权的企微用户
 *   注 1：不走 transcript —— 提问的 execution_start 要等 flush 才落盘，等待期观测不到。
 *   注 2：这条不区分轮次来源：企微发起的轮次卡在提问上，手机端更需要知道。
 *
 * 为什么正文取 transcript 而不是 chatSessions：后者是批量刷盘的，实测每 60 秒只在
 * :29~:32 与 :47~:50 两个窗口写入，轮次结束后要等 0~40 秒才看得到。transcript 逐条追加，
 * 延迟在 1 秒量级。chatSessions 退为兜底（transcript 目录不存在时）。
 *
 * 刻意不做的事：
 * - 不逐 token 流式转发（正文只能在本轮结束后一次性取到）
 * - 不自动批准工具确认（保持 VS Code 的默认安全边界）
 * - 不回复非白名单用户，也不回「无权限」提示（避免变成探测工具）
 * - 不推送思考过程（transcript 里本来就只有 assistant.message.content 是正文）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { logger } from "./logger";
import { WechatBridgeConnection, type WechatBridgeConnectionState } from "./wechatBridgeConnection";
import { WECHAT_BRIDGE_LEASE_HEARTBEAT_MS, WechatBridgeLease } from "./wechatBridgeLease";
import { LiveTurnScanner, resolveTranscriptsDir, type LiveTurn } from "./wechatBridgeLiveTurns";
import {
	InteractionInbox,
	resolveInteractionsDir,
	type PendingInteraction,
} from "./wechatBridgeInteractions";
import {
	buildAuthResultCardRequest,
	buildAuthorizeCardRequest,
	buildMarkdownSendRequest,
	buildStreamRespondRequest,
	createAuthorizeTaskId,
	createBridgeReqId,
	extractInboundEventType,
	extractInboundTextMessage,
	extractInboundUserId,
	extractTemplateCardEvent,
	WECHAT_BRIDGE_AUTH_ACCEPT_KEY,
	WECHAT_BRIDGE_AUTH_REJECT_KEY,
	WECHAT_BRIDGE_AUTH_DONE_KEY,
	type WechatBridgeFrame,
	type WechatBridgeResponse,
	type WechatInboundMessage,
} from "./wechatBridgeProtocol";
import { appendBridgePromptRecord, bridgePromptHash } from "./wechatBridgePromptLedger";
import {
	DEFAULT_WECHAT_BRIDGE_SETTINGS,
	fitWechatMessage,
	normalizePromptText,
	type WechatBridgeInjectTarget,
	type WechatBridgeSettings,
} from "./wechatBridgeSettings";
import {
	hasWechatBridgeCredentials,
	readWechatBridgeCredentials,
	readWechatBridgeSettings,
	writeWechatBridgeCredentials,
	writeWechatBridgeSettings,
} from "./wechatBridgeStore";
import { ChatSessionScanner } from "./wechatBridgeTranscript";

/** 面板展示用的完整状态快照（必须是可结构化克隆的纯数据） */
export interface WechatBridgeState {
	enabled: boolean;
	botId: string;
	hasSecret: boolean;
	injectTarget: WechatBridgeInjectTarget;
	allowedUserId: string;
	respondTimeoutSeconds: number;
	/** 企微发起的轮次是否也推群通知（面板可切） */
	notifyGroupForBridgeTurns: boolean;
	connection: WechatBridgeConnectionState;
	connectionDetail: string;
	holder: string;
	queueDepth: number;
	runningPrompt: string;
	lastActivity: { at: number; prompt: string; ok: boolean; detail: string } | undefined;
	lastRejectedUserId: string;
	/** 最近一次看到的发送者（不要求已授权），发起授权时用它作目标 */
	lastSeenUserId: string;
	/** 从 VS Code 侧发起的那张授权卡片当前走到哪一步 */
	authRequest: WechatBridgeAuthRequest | undefined;
	anchored: boolean;
}

export type WechatBridgeAuthPhase = "pending" | "accepted" | "rejected" | "expired" | "failed";

export interface WechatBridgeAuthRequest {
	taskId: string;
	userId: string;
	phase: WechatBridgeAuthPhase;
	detail: string;
	sentAt: number;
	expiresAt: number;
}

export interface WechatBridgeSettingsInput extends Partial<WechatBridgeSettings> {
	botId?: string;
	secret?: string;
}

interface BridgeTask {
	msgid: string;
	reqId: string;
	userId: string;
	prompt: string;
}

/** msgid 排重用：企微会因网络原因重复推送同一条消息 */
const SEEN_MSGID_LIMIT = 200;
/** 日志轮询间隔；一轮回复通常几十秒，1 秒粒度足够且开销可忽略 */
const TURN_POLL_INTERVAL_MS = 1_000;
/** transcript 轮询间隔。文件是逐条追加的，500 毫秒足够跟上且开销只有几次 stat */
const LIVE_PUMP_INTERVAL_MS = 500;
/** 注入时刻与日志时间戳之间的时钟容差 */
const CLOCK_SLACK_MS = 5_000;
/**
 * 注入后多久还看不到新轮次，就判定注入没生效。
 * 依据 VS Code 源码：会话只读、isInputBlocked、有挂起的模型选择、query 为空白时
 * sendRequest 会静默 rejected，不产生轮次；此时等满整轮超时只会得到一句没信息量的「超时」。
 * 但「没出现」不等于「被拒」：上一轮还在跑时请求只是排队，实测最长晚 43.9s 才创建。
 * 因此这个窗口只在会话确实空闲时才作数（见 waitForLiveTurn），数值取实测排队时间的 1.4 倍。
 */
const INJECTION_CONFIRM_TIMEOUT_MS = 60_000;
/**
 * 企微上那张授权卡片的有效期。
 * 卡片不会自己失效，但超过这个时间还没人点，面板就不再等，避免一直挂着"等待确认"。
 */
const AUTH_REQUEST_TTL_MS = 5 * 60_000;
/** 主动推送的发送回执最多等这么久，拿不到就放弃跟踪（不影响已发出的消息） */
const PUSH_ACK_TTL_MS = 30_000;
/**
 * 企微对单个会话的限流：30 条/分钟、1000 条/小时（回复与主动推送合并计数）。
 * 留住余量给企微消息的回复，别让主动推送把配额吃干净。
 */
const PUSH_PER_MINUTE_LIMIT = 25;
const PUSH_PER_HOUR_LIMIT = 900;
/** 企微注入过但没等到轮次的 prompt 哈希，留一段时间避免迟到的轮次被重复推送 */
const ORPHAN_HASH_TTL_MS = 30 * 60_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class WechatBridgeService implements vscode.Disposable {
	private readonly onDidChangeStateEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	private settings: WechatBridgeSettings = { ...DEFAULT_WECHAT_BRIDGE_SETTINGS };
	private botId = "";
	private secret = "";
	private connection: WechatBridgeConnection | undefined;
	private readonly lease: WechatBridgeLease;
	private leaseTimer: NodeJS.Timeout | undefined;
	private readonly chatSessionsDir: string | undefined;
	private scanner: ChatSessionScanner | undefined;
	private liveScanner: LiveTurnScanner | undefined;
	private liveInbox: InteractionInbox | undefined;
	private livePumpTimer: NodeJS.Timeout | undefined;
	/** 正在等企微注入轮次的等待者，键是归一化后的 prompt */
	private readonly liveWaits = new Map<string, (turn: LiveTurn) => void>();
	/** 企微注入过、但还没被消费掉的 prompt 哈希 → 记录时间 */
	private readonly bridgeInjectedHashes = new Map<string, number>();
	/** 主动推送的时间戳，用于对齐企微的 30 条/分钟、1000 条/小时 */
	private readonly pushTimestamps: number[] = [];

	private readonly queue: BridgeTask[] = [];
	private readonly seenMsgids = new Map<string, number>();
	private running = false;
	private runningTask: BridgeTask | undefined;
	private lastActivity: WechatBridgeState["lastActivity"];
	private lastRejectedUserId = "";
	private lastSeenUserId = "";
	private authRequest: WechatBridgeAuthRequest | undefined;
	/** 主动推送请求的 req_id → 响应回调，用于拿到真实 errcode */
	private readonly pendingSendReqs = new Map<string, (response: WechatBridgeResponse) => void>();
	private anchored = false;
	private readonly notified = new Set<string>();
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		const globalStorage = context.globalStorageUri.fsPath;
		const workspaceName = vscode.workspace.name ?? "未命名窗口";
		this.lease = new WechatBridgeLease(globalStorage, workspaceName);
		// storageUri 形如 <workspaceStorage>/<hash>/<扩展 id>，chatSessions 与它同级
		this.chatSessionsDir = context.storageUri
			? path.join(path.dirname(context.storageUri.fsPath), "chatSessions")
			: undefined;
	}

	async start(): Promise<void> {
		this.settings = readWechatBridgeSettings(this.context);
		const credentials = await readWechatBridgeCredentials(this.context);
		this.botId = credentials.botId;
		this.secret = credentials.secret;
		this.syncLiveTurnPump();
		this.emitChange();
		if (this.settings.enabled && hasWechatBridgeCredentials(credentials)) {
			this.connect();
		}
	}

	async applySettings(input: WechatBridgeSettingsInput): Promise<WechatBridgeState> {
		const credentialsChanged = input.botId !== undefined || (input.secret !== undefined && input.secret.trim() !== "");
		if (credentialsChanged) {
			await writeWechatBridgeCredentials(this.context, { botId: input.botId, secret: input.secret });
			const credentials = await readWechatBridgeCredentials(this.context);
			this.botId = credentials.botId;
			this.secret = credentials.secret;
		}
		this.settings = await writeWechatBridgeSettings(this.context, {
			enabled: input.enabled ?? this.settings.enabled,
			injectTarget: input.injectTarget ?? this.settings.injectTarget,
			allowedUserId: input.allowedUserId ?? this.settings.allowedUserId,
			respondTimeoutSeconds: input.respondTimeoutSeconds ?? this.settings.respondTimeoutSeconds,
			notifyGroupForBridgeTurns: input.notifyGroupForBridgeTurns ?? this.settings.notifyGroupForBridgeTurns,
		});

		if (!this.settings.enabled) {
			this.disconnect("已在面板中关闭");
		} else if (credentialsChanged) {
			// 凭证变了必须重建连接：订阅只在建连时做一次
			this.disconnect("凭证已更新，正在重新连接");
			this.connect();
		} else if (!this.connection) {
			this.connect();
		}
		this.syncLiveTurnPump();
		this.emitChange();
		return this.getState();
	}

	/** 保存设置但不触发重连（面板自动保存时用，避免每敲一个字就重连） */
	async applySettingsQuiet(input: WechatBridgeSettingsInput): Promise<WechatBridgeState> {
		this.settings = await writeWechatBridgeSettings(this.context, {
			enabled: input.enabled ?? this.settings.enabled,
			injectTarget: input.injectTarget ?? this.settings.injectTarget,
			allowedUserId: input.allowedUserId ?? this.settings.allowedUserId,
			respondTimeoutSeconds: input.respondTimeoutSeconds ?? this.settings.respondTimeoutSeconds,
			notifyGroupForBridgeTurns: input.notifyGroupForBridgeTurns ?? this.settings.notifyGroupForBridgeTurns,
		});
		if (!this.settings.enabled) {
			this.disconnect("已在面板中关闭");
		}
		this.syncLiveTurnPump();
		this.emitChange();
		return this.getState();
	}

	reconnect(): void {
		this.disconnect("手动重连");
		this.connect();
		this.emitChange();
	}

	disconnect(reason = "已断开"): void {
		this.stopLeaseHeartbeat();
		const connection = this.connection;
		this.connection = undefined;
		connection?.disconnect();
		this.lease.release();
		logger.info("wechat-bridge", { event: "disconnected", reason });
		this.emitChange();
	}

	/** 让下一次注入重新新建会话（专用会话模式下"切走了就找不回来"的解法） */
	resetSession(): WechatBridgeState {
		this.anchored = false;
		this.emitChange();
		return this.getState();
	}

	/** 「授权最近一位发送者」：面板按钮用，避免手工抄加密 userid */
	authorizeLastRejected(): void {
		if (!this.lastRejectedUserId) {
			return;
		}
		this.settings = { ...this.settings, allowedUserId: this.lastRejectedUserId };
		void writeWechatBridgeSettings(this.context, this.settings);
		this.lastRejectedUserId = "";
		this.emitChange();
	}

	/**
	 * 授权方式二：从面板发起，向企微推一张授权卡片，由用户在企微里点允许/拒绝。
	 *
	 * 只能推给「已经给机器人发过消息」的人：企微要求会话先存在才能主动推送，
	 * 我们也确实需要对方先在企微出现一次才知道往哪发（userid 是加密值）。
	 */
	requestAuthorizationFromWechat(): WechatBridgeState {
		const now = Date.now();
		const fail = (detail: string): WechatBridgeState => {
			this.authRequest = { taskId: "", userId: "", phase: "failed", detail, sentAt: now, expiresAt: now };
			this.emitChange();
			return this.getState();
		};
		const connection = this.connection;
		if (!connection?.isSubscribed) {
			return fail("长连接还没就绪，请先连接成功再发起授权");
		}
		const target = this.settings.allowedUserId || this.lastRejectedUserId || this.lastSeenUserId;
		if (!target) {
			return fail("还没收到过任何人的消息：请先在企微里给机器人发一句话，再回来发起授权");
		}
		const taskId = createAuthorizeTaskId();
		const reqId = createBridgeReqId();
		this.authRequest = {
			taskId,
			userId: target,
			phase: "pending",
			detail: "",
			sentAt: now,
			expiresAt: now + AUTH_REQUEST_TTL_MS,
		};
		this.pendingSendReqs.set(reqId, (response) => {
			const current = this.authRequest;
			if (!current || current.taskId !== taskId || current.phase !== "pending") {
				return;
			}
			if (response.errcode !== 0) {
				this.authRequest = {
					...current,
					phase: "failed",
					detail: `企微拒绝发送：${response.errcode} ${response.errmsg}`.trim(),
				};
				this.emitChange();
			}
		});
		const forget = setTimeout(() => this.pendingSendReqs.delete(reqId), AUTH_REQUEST_TTL_MS);
		forget.unref?.();

		const sent = connection.send(
			buildAuthorizeCardRequest(reqId, {
				taskId,
				userId: target,
				computerName: vscode.workspace.name ?? "未命名窗口",
				ttlMinutes: Math.round(AUTH_REQUEST_TTL_MS / 60_000),
			})
		);
		if (!sent) {
			this.pendingSendReqs.delete(reqId);
			return fail("授权卡片发送失败（连接已断开）");
		}
		logger.info("wechat-bridge", { event: "auth-card-sent", taskId });
		this.emitChange();
		return this.getState();
	}

	/** 撤销授权：清空白名单，之后来自任何人的消息都不再处理 */
	revokeAuthorization(): WechatBridgeState {
		this.settings = { ...this.settings, allowedUserId: "" };
		void writeWechatBridgeSettings(this.context, this.settings);
		this.authRequest = undefined;
		this.emitChange();
		return this.getState();
	}

	getState(): WechatBridgeState {
		const connection = this.connection;
		return {
			enabled: this.settings.enabled,
			botId: this.botId,
			hasSecret: Boolean(this.secret),
			injectTarget: this.settings.injectTarget,
			allowedUserId: this.settings.allowedUserId,
			respondTimeoutSeconds: this.settings.respondTimeoutSeconds,
			notifyGroupForBridgeTurns: this.settings.notifyGroupForBridgeTurns,
			connection: connection?.state ?? "idle",
			connectionDetail: connection?.detail ?? "",
			holder: this.lease.describeHolder() ?? "",
			queueDepth: this.queue.length,
			runningPrompt: this.runningTask?.prompt ?? "",
			lastActivity: this.lastActivity,
			lastRejectedUserId: this.lastRejectedUserId,
			lastSeenUserId: this.lastSeenUserId,
			authRequest: this.currentAuthRequest(),
			anchored: this.anchored,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.stopLiveTurnPump();
		this.stopLeaseHeartbeat();
		this.connection?.disconnect();
		this.connection = undefined;
		this.pendingSendReqs.clear();
		this.liveWaits.clear();
		this.bridgeInjectedHashes.clear();
		this.lease.release();
		this.onDidChangeStateEmitter.dispose();
	}

	/** 过期的待确认请求在读取状态时就地改写，避免面板一直停在「等待确认」 */
	private currentAuthRequest(): WechatBridgeAuthRequest | undefined {
		const request = this.authRequest;
		if (!request) {
			return undefined;
		}
		if (request.phase === "pending" && Date.now() > request.expiresAt) {
			this.authRequest = { ...request, phase: "expired", detail: "授权请求已过期，可重新发起" };
		}
		return this.authRequest;
	}

	private connect(): void {
		if (this.disposed) {
			return;
		}
		if (!this.botId || !this.secret) {
			this.notifyOnce("no-credentials", "企微对话：还没有配置 BotID / Secret，无法连接。");
			this.emitChange();
			return;
		}
		if (!this.lease.tryAcquire()) {
			this.notifyOnce("lease-busy", `企微对话：该机器人已被「${this.lease.describeHolder() ?? "另一个窗口"}」占用。`);
			this.emitChange();
			return;
		}
		this.startLeaseHeartbeat();
		this.connection?.disconnect();
		this.connection = new WechatBridgeConnection(this.botId, this.secret, {
			onFrame: (frame) => this.handleFrame(frame),
			onStateChange: (state, detail) => this.handleConnectionState(state, detail),
			onDisconnectedEvent: () => this.handleKicked(),
			onResponse: (response) => this.handleResponse(response),
		});
		this.connection.connect();
		this.emitChange();
	}

	private handleConnectionState(state: WechatBridgeConnectionState, detail?: string): void {
		logger.info("wechat-bridge", { event: "connection-state", state, detail });
		if (state === "failed" || state === "kicked") {
			this.notifyOnce(`${state}:${detail ?? ""}`, `企微对话连接异常：${detail ?? state}`);
		}
		this.emitChange();
	}

	private handleKicked(): void {
		this.stopLeaseHeartbeat();
		this.lease.release();
		this.notifyOnce("kicked-event", "企微对话：该机器人已被其他客户端或窗口接管，本窗口已停止重连。");
		this.emitChange();
	}

	private handleFrame(frame: WechatBridgeFrame): void {
		const userId = extractInboundUserId(frame);
		if (userId) {
			this.rememberUserId(userId);
		}
		const eventType = extractInboundEventType(frame);
		if (eventType) {
			logger.info("wechat-bridge", { event: "inbound-event", eventType });
			if (eventType === "template_card_event") {
				this.handleTemplateCardEvent(frame);
			}
			return;
		}
		const message = extractInboundTextMessage(frame);
		if (!message) {
			logger.debug("wechat-bridge", { event: "frame-ignored", cmd: frame.cmd });
			return;
		}
		this.handleInboundMessage(message);
	}

	private handleResponse(response: WechatBridgeResponse): void {
		const reqId = response.reqId;
		if (!reqId) {
			return;
		}
		const callback = this.pendingSendReqs.get(reqId);
		if (!callback) {
			return;
		}
		this.pendingSendReqs.delete(reqId);
		callback(response);
	}

	private rememberUserId(userId: string): void {
		if (this.lastSeenUserId === userId) {
			return;
		}
		this.lastSeenUserId = userId;
		this.emitChange();
	}

	/** 用户点了授权卡片上的按钮 */
	private handleTemplateCardEvent(frame: WechatBridgeFrame): void {
		const event = extractTemplateCardEvent(frame);
		if (!event) {
			logger.warn("wechat-bridge", { event: "template-card-event-unusable" });
			return;
		}
		if (event.eventKey === WECHAT_BRIDGE_AUTH_DONE_KEY) {
			return;
		}
		const request = this.authRequest;
		if (!request || event.taskId !== request.taskId) {
			// 不是本窗口发的那张卡片（可能来自另一个窗口或已过期），不处理
			logger.info("wechat-bridge", { event: "template-card-event-ignored", taskId: event.taskId });
			return;
		}
		const accepted = event.eventKey === WECHAT_BRIDGE_AUTH_ACCEPT_KEY;
		if (!accepted && event.eventKey !== WECHAT_BRIDGE_AUTH_REJECT_KEY) {
			return;
		}
		//
		// 只认发起时选定的那个人的点击。
		// 否则卡片一旦被转发，别人点「允许」就会把自己写进白名单，等于拿到本机 agent 的使用权。
		const senderMatches = event.userId === request.userId;
		if (accepted && !senderMatches) {
			logger.warn("wechat-bridge", {
				event: "auth-card-wrong-sender",
				expectedLength: request.userId.length,
				actualLength: event.userId.length,
			});
			this.authRequest = {
				...request,
				phase: "rejected",
				detail: "点击者不是发起时选定的那个人，已忽略",
			};
			this.replyAuthCard(event.reqId, request.taskId, false, "未生效", "身份不匹配");
			this.emitChange();
			return;
		}
		if (accepted) {
			this.settings = { ...this.settings, allowedUserId: request.userId };
			void writeWechatBridgeSettings(this.context, this.settings);
			this.lastRejectedUserId = "";
		}
		this.authRequest = {
			...request,
			phase: accepted ? "accepted" : "rejected",
			detail: accepted ? "已在企微确认" : "已在企微拒绝",
		};
		logger.info("wechat-bridge", {
			event: "auth-card-answered",
			accepted,
			userIdLength: event.userId.length,
		});
		this.replyAuthCard(
			event.reqId,
			event.taskId,
			accepted,
			accepted ? "已授权这台电脑" : "已拒绝授权",
			accepted ? "现在可以发消息了" : "未做任何变更"
		);
		this.emitChange();
	}

	/** 企微只在收到点击事件后 5 秒内接受卡片更新，过了就丢弃；失败不影响授权结果本身 */
	private replyAuthCard(reqId: string, taskId: string, accepted: boolean, title: string, desc: string): void {
		this.connection?.send(
			buildAuthResultCardRequest(reqId, { taskId, title, desc, accepted })
		);
	}

	private handleInboundMessage(message: WechatInboundMessage): void {
		if (!this.settings.enabled) {
			return;
		}
		if (this.isDuplicate(message.msgid)) {
			logger.debug("wechat-bridge", { event: "duplicate-msgid", msgid: message.msgid });
			return;
		}
		if (message.chatType !== "single") {
			logger.info("wechat-bridge", { event: "rejected-chat-type", chatType: message.chatType });
			return;
		}
		const allowed = this.settings.allowedUserId;
		const senderMatched = Boolean(allowed) && allowed.toLowerCase() === message.userId.toLowerCase();
		if (!senderMatched) {
			this.lastRejectedUserId = message.userId;
			logger.warn("wechat-bridge", { event: "rejected-sender", userId: message.userId });
			this.emitChange();
			return;
		}
		const prompt = message.content.trim();
		if (!prompt) {
			return;
		}
		logger.info("wechat-bridge", {
			event: "accepted-message",
			msgid: message.msgid,
			length: prompt.length,
		});
		this.queue.push({ msgid: message.msgid, reqId: message.reqId, userId: message.userId, prompt });
		this.emitChange();
		void this.drainQueue();
	}

	private isDuplicate(msgid: string): boolean {
		if (this.seenMsgids.has(msgid)) {
			return true;
		}
		this.seenMsgids.set(msgid, Date.now());
		if (this.seenMsgids.size > SEEN_MSGID_LIMIT) {
			const oldest = [...this.seenMsgids.entries()].sort((a, b) => a[1] - b[1]).slice(0, 50);
			for (const [key] of oldest) {
				this.seenMsgids.delete(key);
			}
		}
		return false;
	}

	private async drainQueue(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			for (let task = this.queue.shift(); task; task = this.queue.shift()) {
				this.runningTask = task;
				this.emitChange();
				await this.runTask(task);
				this.runningTask = undefined;
				this.emitChange();
			}
		} finally {
			this.running = false;
			this.runningTask = undefined;
			this.emitChange();
		}
	}

	private async runTask(task: BridgeTask): Promise<void> {
		const connection = this.connection;
		const startedAt = Date.now();
		let ok = true;
		let detail = "";
		let reply: string;
		try {
			// 先回一条确认？否。stream 有"首次推送后 10 分钟内必须 finish"的硬限制，
			// 超过 10 分钟的 agent 轮次会让这条消息永远停在未完成态。
			const markdown = await this.injectAndWaitForTurn(task, startedAt - CLOCK_SLACK_MS);
			// 只调工具不产出文本是真实存在的；VS Code 里都没得看，就别发占位文案刷屏
			reply = fitWechatMessage(markdown);
		} catch (error) {
			ok = false;
			detail = errorMessage(error);
			reply = `❌ 处理失败：${detail}`;
		}
		const payload = buildStreamRespondRequest(task.reqId, task.msgid, reply);
		// 等待期间可能发生过重连：优先用当前连接，避免回复发到已经关掉的 socket 上
		const sent = (this.connection ?? connection)?.send(payload) ?? false;
		if (!sent) {
			detail = detail ? `${detail}；回复发送失败` : "回复发送失败（连接已断开）";
			ok = false;
		}
		this.lastActivity = {
			at: Date.now(),
			prompt: task.prompt.slice(0, 80),
			ok,
			detail,
		};
		logger.info("wechat-bridge", {
			event: "turn-finished",
			ok,
			sent,
			durationMs: Date.now() - startedAt,
			replyLength: reply.length,
		});
		this.emitChange();
	}

	private async injectAndWaitForTurn(task: BridgeTask, sinceMs: number): Promise<string> {
		const live = this.ensureLiveScanner();
		const legacy = this.ensureScanner();
		if (!live && !legacy) {
			throw new Error("当前窗口没有工作区，读不到会话日志，无法取回回复");
		}
		if (this.settings.injectTarget === "dedicated" && !this.anchored) {
			await vscode.commands.executeCommand("workbench.action.chat.newChat");
			this.anchored = true;
		}
		if (this.settings.injectTarget === "current") {
			this.anchored = true;
		}
		// 记一笔来源台账，Stop hook 据此跳过群通知（同一轮不该通知两遍）；用户要求在群里留痕时就不记
		if (!this.settings.notifyGroupForBridgeTurns) {
			appendBridgePromptRecord(task.prompt);
		}
		const key = normalizePromptText(task.prompt);
		this.rememberBridgeInjection(task.prompt);
		await vscode.commands.executeCommand("workbench.action.chat.open", {
			query: task.prompt,
			preserveInput: true,
		});
		// 命令返回时请求已经提交，transcript 里的 user.message 就是 query 原文，所以下面能靠 prompt 精确命中。
		const injectedAt = Date.now();
		if (!live) {
			return await this.waitForLegacyTurn(task, sinceMs, injectedAt);
		}
		const turn = await this.waitForLiveTurn(
			key,
			injectedAt + this.settings.respondTimeoutSeconds * 1000,
			injectedAt + INJECTION_CONFIRM_TIMEOUT_MS
		);
		return turn.markdown;
	}

	/**
	 * 等 transcript 里出现该 prompt 的轮次并结束。
	 *
	 * 用「泵 + 等待者」而不是自己轮询文件：pump 是唯一的读取者，
	 * 两条读取路径并存会互相抢轮次（谁先读到谁拿走，另一条永远看不到）。
	 */
	private async waitForLiveTurn(key: string, deadline: number, confirmDeadline: number): Promise<LiveTurn> {
		const scanner = this.liveScanner;
		let timer: NodeJS.Timeout | undefined;
		let finished = false;
		return await new Promise<LiveTurn>((resolve, reject) => {
			const finish = (): void => {
				finished = true;
				if (timer) {
					clearInterval(timer);
					timer = undefined;
				}
				if (this.liveWaits.get(key) === handler) {
					this.liveWaits.delete(key);
				}
			};
			const handler = (turn: LiveTurn): void => {
				if (finished) {
					return;
				}
				finish();
				this.consumeBridgeInjection(turn.prompt);
				resolve(turn);
			};
			this.liveWaits.set(key, handler);
			let confirmAt = confirmDeadline;
			let idleChecks = 0;
			timer = setInterval(() => {
				if (finished) {
					return;
				}
				if (this.disposed) {
					finish();
					reject(new Error("窗口已关闭"));
					return;
				}
				const now = Date.now();
				if (now >= deadline) {
					finish();
					reject(new Error(`等待对话结果超时（${this.settings.respondTimeoutSeconds} 秒）`));
					return;
				}
				if (now < confirmAt) {
					return;
				}
				if (scanner?.hasPendingPrompt(key)) {
					// 已经跑起来了，确认阶段的活干完了
					confirmAt = Number.POSITIVE_INFINITY;
					return;
				}
				if (scanner?.isBusy()) {
					// 上一轮还没跑完：请求只是排队，不是注入失败，继续等
					idleChecks = 0;
					confirmAt = now + INJECTION_CONFIRM_TIMEOUT_MS;
					return;
				}
				// 排队轮次的 user.message 紧跟上一轮 turn_end（实测间隔 ≥63ms），
				// 轮询可能恰好落在两者之间，连续两次都空闲才敢判定没生效
				idleChecks += 1;
				if (idleChecks < 2) {
					confirmAt = now + LIVE_PUMP_INTERVAL_MS * 2;
					return;
				}
				finish();
				reject(
					new Error(
						"注入没有生效：对话可能处于只读、正在执行中，或输入框被占用，请到 VS Code 里确认后再发一次"
					)
				);
			}, LIVE_PUMP_INTERVAL_MS);
			timer.unref?.();
			if (finished) {
				// handler 在 setInterval 之前就被 pump 命中的极端情况，别留下空转的定时器
				clearInterval(timer);
				timer = undefined;
			}
		});
	}

	/** chatSessions 兜底：transcript 目录不存在（旧版宿主、被关闭的记录）时用 */
	private async waitForLegacyTurn(task: BridgeTask, sinceMs: number, injectedAt: number): Promise<string> {
		const scanner = this.ensureScanner();
		if (!scanner) {
			throw new Error("当前窗口没有工作区，读不到会话日志，无法取回回复");
		}
		let sawNewTurn = false;
		const deadline = Date.now() + this.settings.respondTimeoutSeconds * 1000;
		while (Date.now() < deadline && !this.disposed) {
			await delay(TURN_POLL_INTERVAL_MS);
			const match = scanner.findTurn(task.prompt, sinceMs);
			if (!match) {
				if (!sawNewTurn && Date.now() - injectedAt > INJECTION_CONFIRM_TIMEOUT_MS) {
					throw new Error(
						"注入没有生效：对话可能处于只读、正在执行中，或输入框被占用，请到 VS Code 里确认后再发一次"
					);
				}
				continue;
			}
			sawNewTurn = true;
			if (match.turn.completed) {
				if (match.turn.matched === "fallback") {
					logger.warn("wechat-bridge", { event: "turn-matched-by-fallback", filePath: match.filePath });
				}
				return match.turn.markdown;
			}
		}
		throw new Error(`等待对话结果超时（${this.settings.respondTimeoutSeconds} 秒）`);
	}

	private ensureScanner(): ChatSessionScanner | undefined {
		if (!this.chatSessionsDir) {
			return undefined;
		}
		if (!this.scanner) {
			this.scanner = new ChatSessionScanner(this.chatSessionsDir);
		}
		// 目录可能还不存在（首次对话前），存在性只影响本次结果，不缓存失败
		if (!fs.existsSync(this.chatSessionsDir)) {
			logger.debug("wechat-bridge", { event: "chat-sessions-missing", dir: this.chatSessionsDir });
		}
		return this.scanner;
	}

	/**
	 * transcript 目录只在有过对话后才存在，所以不缓存失败：每次没找到就下次再找。
	 */
	private ensureLiveScanner(): LiveTurnScanner | undefined {
		if (this.liveScanner) {
			return this.liveScanner;
		}
		if (!this.chatSessionsDir) {
			return undefined;
		}
		const dir = resolveTranscriptsDir(this.chatSessionsDir);
		if (!dir) {
			return undefined;
		}
		this.liveScanner = new LiveTurnScanner(dir);
		// 提问提醒走 preToolUse hook 写的 sidecar：transcript 是批量的，等不到它
		this.liveInbox = new InteractionInbox(resolveInteractionsDir(dir));
		logger.info("wechat-bridge", { event: "live-transcripts-found", dir });
		return this.liveScanner;
	}

	private syncLiveTurnPump(): void {
		if (this.disposed || !this.settings.enabled) {
			this.stopLiveTurnPump();
			return;
		}
		if (this.livePumpTimer) {
			return;
		}
		this.livePumpTimer = setInterval(() => this.pumpLiveTurns(), LIVE_PUMP_INTERVAL_MS);
		this.livePumpTimer.unref?.();
	}

	private stopLiveTurnPump(): void {
		if (this.livePumpTimer) {
			clearInterval(this.livePumpTimer);
			this.livePumpTimer = undefined;
		}
	}

	/** transcript 的唯一读取者：拿到新结束的轮次，先看是不是企微注入的，其余推给企微 */
	private pumpLiveTurns(): void {
		const scanner = this.ensureLiveScanner();
		if (!scanner) {
			return;
		}
		let turns: LiveTurn[];
		try {
			turns = scanner.poll();
		} catch (error) {
			logger.warn("wechat-bridge", { event: "live-pump-failed", detail: errorMessage(error) });
			return;
		}
		for (const turn of turns) {
			if (this.settleLiveWait(turn)) {
				continue;
			}
			this.pushLiveTurn(turn);
		}
		const inbox = this.liveInbox;
		if (!inbox) {
			return;
		}
		let interactions: PendingInteraction[];
		try {
			interactions = inbox.poll();
		} catch (error) {
			logger.warn("wechat-bridge", { event: "interaction-poll-failed", detail: errorMessage(error) });
			return;
		}
		for (const interaction of interactions) {
			this.pushInteraction(interaction);
		}
	}

	private settleLiveWait(turn: LiveTurn): boolean {
		if (this.liveWaits.size === 0) {
			return false;
		}
		const waiter = this.liveWaits.get(normalizePromptText(turn.prompt));
		if (!waiter) {
			return false;
		}
		waiter(turn);
		return true;
	}

	/**
	 * 把 VS Code 里结束的一轮正文主动推到企微。
	 *
	 * 不加前缀、不带思考过程：用户要的就是「本轮回复原文」，在手机上接着看。
	 */
	private pushLiveTurn(turn: LiveTurn): void {
		// 企微注入过的轮次：回复走 aibot_respond_msg 回同一个回调，再推一遍就重复了
		if (this.consumeBridgeInjection(turn.prompt)) {
			return;
		}
		const markdown = turn.markdown.trim();
		if (!markdown) {
			logger.debug("wechat-bridge", { event: "live-turn-empty", sessionId: turn.sessionId });
			return;
		}
		this.pushMarkdown(markdown, "live-turn", { sessionId: turn.sessionId });
	}

	/**
	 * 「VS Code 正在等你选择」的提醒。
	 *
	 * 事件来自 preToolUse hook 落盘的 sidecar：提问工具在用户回答前不写 turn_end，
	 * 它的 execution_start 也只先进内存缓冲、要等 flush 才落盘，所以 transcript 里观测不到。
	 * 不像企微发起的轮次，这条不做来源去重：手机端更需要知道有人在等它。
	 */
	private pushInteraction(interaction: PendingInteraction): void {
		this.pushMarkdown(interaction.markdown, "live-interaction", { sessionId: interaction.sessionId });
	}

	/** 主动推送一条 markdown；订阅、目标白名单与限流都在这里收口 */
	private pushMarkdown(markdown: string, event: string, detail: Record<string, unknown>): void {
		const connection = this.connection;
		if (!this.settings.enabled || !connection?.isSubscribed) {
			return;
		}
		const target = this.settings.allowedUserId;
		if (!target) {
			logger.debug("wechat-bridge", { event: `${event}-no-target` });
			return;
		}
		const content = fitWechatMessage(markdown);
		if (!content) {
			return;
		}
		if (!this.takePushQuota(Date.now())) {
			logger.warn("wechat-bridge", { event: `${event}-rate-limited`, ...detail });
			return;
		}
		const reqId = createBridgeReqId();
		const forget = setTimeout(() => this.pendingSendReqs.delete(reqId), PUSH_ACK_TTL_MS);
		forget.unref?.();
		this.pendingSendReqs.set(reqId, (response) => {
			clearTimeout(forget);
			if (response.errcode === 0) {
				logger.info("wechat-bridge", {
					event: `${event}-pushed`,
					length: content.length,
					...detail,
				});
				return;
			}
			logger.warn("wechat-bridge", {
				event: `${event}-push-rejected`,
				errcode: response.errcode,
				errmsg: response.errmsg,
			});
		});
		if (!connection.send(buildMarkdownSendRequest(reqId, target, content))) {
			clearTimeout(forget);
			this.pendingSendReqs.delete(reqId);
			logger.warn("wechat-bridge", { event: `${event}-push-unsent`, ...detail });
		}
	}

	/** 企微限流：30 条/分钟、1000 条/小时，回复和主动推送合并计数，这里给回复留一点余量 */
	private takePushQuota(now: number): boolean {
		while (this.pushTimestamps.length > 0 && now - this.pushTimestamps[0] > 3_600_000) {
			this.pushTimestamps.shift();
		}
		if (this.pushTimestamps.length >= PUSH_PER_HOUR_LIMIT) {
			return false;
		}
		const inLastMinute = this.pushTimestamps.filter((at) => now - at < 60_000).length;
		if (inLastMinute >= PUSH_PER_MINUTE_LIMIT) {
			return false;
		}
		this.pushTimestamps.push(now);
		return true;
	}

	private rememberBridgeInjection(prompt: string): void {
		const now = Date.now();
		for (const [hash, at] of this.bridgeInjectedHashes) {
			if (now - at > ORPHAN_HASH_TTL_MS) {
				this.bridgeInjectedHashes.delete(hash);
			}
		}
		this.bridgeInjectedHashes.set(bridgePromptHash(prompt), now);
	}

	/** 消费掉「这轮来自企微」的标记：命中即代表不该再主动推一遍 */
	private consumeBridgeInjection(prompt: string): boolean {
		return this.bridgeInjectedHashes.delete(bridgePromptHash(prompt));
	}

	private startLeaseHeartbeat(): void {
		this.stopLeaseHeartbeat();
		this.leaseTimer = setInterval(() => {
			if (!this.lease.renew()) {
				// 租约被别人抢走：立即停连，避免互踢
				this.notifyOnce("lease-lost", "企微对话：该机器人已被另一个窗口接管，本窗口已断开。");
				this.disconnect("租约已被接管");
			}
		}, WECHAT_BRIDGE_LEASE_HEARTBEAT_MS);
		this.leaseTimer.unref?.();
	}

	private stopLeaseHeartbeat(): void {
		if (this.leaseTimer) {
			clearInterval(this.leaseTimer);
			this.leaseTimer = undefined;
		}
	}

	private notifyOnce(key: string, message: string): void {
		if (this.notified.has(key)) {
			return;
		}
		this.notified.add(key);
		void vscode.window.showWarningMessage(message);
	}

	private emitChange(): void {
		this.onDidChangeStateEmitter.fire();
	}
}
