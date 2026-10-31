import * as assert from "assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildAuthResultCardRequest,
	buildAuthorizeCardRequest,
	buildPingRequest,
	buildStreamRespondRequest,
	buildSubscribeRequest,
	createAuthorizeTaskId,
	extractInboundEventType,
	extractInboundTextMessage,
	extractInboundUserId,
	extractTemplateCardEvent,
	parseBridgeFrame,
	parseBridgeResponse,
	WECHAT_BRIDGE_AUTH_ACCEPT_KEY,
	WECHAT_BRIDGE_AUTH_DONE_KEY,
	WECHAT_BRIDGE_AUTH_REJECT_KEY,
} from "../wechatBridgeProtocol";
import {
	BRIDGE_PROMPT_LEDGER_TTL_MS,
	appendBridgePromptRecord,
	bridgePromptHash,
	bridgePromptLedgerPath,
	isBridgeInjectedPrompt,
} from "../wechatBridgePromptLedger";
import {
	DEFAULT_WECHAT_BRIDGE_SETTINGS,
	WECHAT_BRIDGE_MESSAGE_MAX_BYTES,
	fitWechatMessage,
	normalizePromptText,
	sanitizeWechatBridgeSettings,
	truncateUtf8,
} from "../wechatBridgeSettings";
import {
	ChatSessionLogTail,
	extractAssistantMarkdown,
	findLatestTurn,
	findTurnByPrompt,
	replaySessionLog,
} from "../wechatBridgeTranscript";
import { WechatBridgeConnection } from "../wechatBridgeConnection";

/**
 * 这些断言守住的是「和企微协议对不上就会静默失效」的几条：
 * req_id 必须透传、流式回复必须带 finish、正文只能取无 kind 的部件。
 * 协议出处：developer.work.weixin.qq.com/document/path/101834、101836。
 */
suite("企微对话桥接协议", () => {
	test("订阅帧带 cmd / headers.req_id / bot_id 与 secret", () => {
		const parsed = JSON.parse(buildSubscribeRequest("bot-1", "sec-1", "req-1"));
		assert.strictEqual(parsed.cmd, "aibot_subscribe");
		assert.strictEqual(parsed.headers.req_id, "req-1");
		assert.strictEqual(parsed.body.bot_id, "bot-1");
		assert.strictEqual(parsed.body.secret, "sec-1");
	});

	test("心跳帧只带 cmd 与 req_id", () => {
		const parsed = JSON.parse(buildPingRequest("req-2"));
		assert.deepStrictEqual(parsed, { cmd: "ping", headers: { req_id: "req-2" } });
	});

	test("流式回复必须复用回调的 req_id 并带 finish=true", () => {
		const parsed = JSON.parse(buildStreamRespondRequest("req-3", "msg-9", "你好"));
		assert.strictEqual(parsed.cmd, "aibot_respond_msg");
		assert.strictEqual(parsed.headers.req_id, "req-3");
		assert.strictEqual(parsed.body.msgtype, "stream");
		assert.strictEqual(parsed.body.stream.id, "msg-9");
		assert.strictEqual(parsed.body.stream.finish, true);
		assert.strictEqual(parsed.body.stream.content, "你好");
	});

	test("响应帧没有 cmd，靠 errcode 判定", () => {
		const frame = parseBridgeFrame('{"headers":{"req_id":"r"},"errcode":0,"errmsg":"ok"}');
		assert.ok(frame);
		assert.deepStrictEqual(parseBridgeResponse(frame), { reqId: "r", errcode: 0, errmsg: "ok" });
		assert.strictEqual(parseBridgeResponse({ cmd: "ping", errcode: 0 }), undefined);
	});

	test("非 JSON 与数组一律当作无帧", () => {
		assert.strictEqual(parseBridgeFrame("not json"), undefined);
		assert.strictEqual(parseBridgeFrame("[1,2]"), undefined);
		assert.strictEqual(parseBridgeFrame(undefined), undefined);
	});

	test("只认单聊纯文本普通用户消息", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: "req-4" },
				body: {
					msgid: "msg-1",
					chattype: "single",
					from: { userid: "u1" },
					msgtype: "text",
					text: { content: "跑一下单测" },
				},
			})
		);
		assert.ok(frame);
		assert.deepStrictEqual(extractInboundTextMessage(frame), {
			msgid: "msg-1",
			reqId: "req-4",
			chatType: "single",
			userId: "u1",
			content: "跑一下单测",
		});
	});

	test("缺 req_id 的消息不处理，否则回复时无法透传", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: {},
				body: { msgid: "m", chattype: "single", from: { userid: "u" }, msgtype: "text", text: { content: "x" } },
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundTextMessage(frame), undefined);
	});

	test("来自智能助理/频道的消息带 compat_info，必须忽略", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: "r" },
				body: {
					msgid: "m",
					chattype: "group",
					from: { userid: "u" },
					msgtype: "text",
					text: { content: "x" },
					compat_info: { source: "ai_assistant" },
				},
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundTextMessage(frame), undefined);
	});

	test("图片等非文本消息不处理", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: "r" },
				body: { msgid: "m", chattype: "single", from: { userid: "u" }, msgtype: "image", image: {} },
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundTextMessage(frame), undefined);
	});

	test("被顶号事件的类型在 body.event.eventtype 下，不在 body.disconnected_event 下", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				headers: { req_id: "r" },
				body: { event: { eventtype: "disconnected_event", disconnected_event: { aibotid: "b" } } },
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundEventType(frame), "disconnected_event");
	});

	test("万一服务端把事件体平铺回 body，仍能识别", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({ cmd: "aibot_event_callback", body: { disconnected_event: { aibotid: "b" } } })
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundEventType(frame), "disconnected_event");
	});

	test("非事件回调不报告事件类型", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({ cmd: "aibot_msg_callback", body: { event: { eventtype: "enter_chat" } } })
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundEventType(frame), undefined);
	});

	test("事件与消息都从 body.from.userid 取发送者", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				body: { event: { eventtype: "enter_chat" }, from: { userid: "enc-user-1" } },
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractInboundUserId(frame), "enc-user-1");
		assert.strictEqual(extractInboundUserId({ cmd: "aibot_event_callback" }), undefined);
	});

	test("从模板卡片事件里取出 task_id / event_key / req_id / 点击者", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				headers: { req_id: "req-card-1" },
				body: {
					event: {
						eventtype: "template_card_event",
						template_card_event: {
							card_type: "button_interaction",
							task_id: "libiao-auth-abc",
							event_key: WECHAT_BRIDGE_AUTH_ACCEPT_KEY,
						},
					},
					from: { userid: "enc-user-1" },
				},
			})
		);
		assert.ok(frame);
		assert.deepStrictEqual(extractTemplateCardEvent(frame), {
			taskId: "libiao-auth-abc",
			eventKey: WECHAT_BRIDGE_AUTH_ACCEPT_KEY,
			cardType: "button_interaction",
			userId: "enc-user-1",
			reqId: "req-card-1",
		});
	});

	test("缺 req_id 的卡片点击不处理，否则无法在 5 秒内回写卡片", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				headers: {},
				body: {
					event: {
						eventtype: "template_card_event",
						template_card_event: { card_type: "button_interaction", task_id: "t", event_key: "k" },
					},
					from: { userid: "u" },
				},
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractTemplateCardEvent(frame), undefined);
	});

	test("缺 task_id 时返回空串，交给上层比对失败", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				headers: { req_id: "r" },
				body: {
					event: {
						eventtype: "template_card_event",
						template_card_event: { card_type: "button_interaction", event_key: "k" },
					},
					from: { userid: "u" },
				},
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractTemplateCardEvent(frame)?.taskId, "");
	});

	test("别的卡片事件不会被误当成授权事件", () => {
		const frame = parseBridgeFrame(
			JSON.stringify({
				cmd: "aibot_event_callback",
				headers: { req_id: "r" },
				body: {
					event: { eventtype: "feedback_event", feedback_event: { event_key: "k", task_id: "t" } },
					from: { userid: "u" },
				},
			})
		);
		assert.ok(frame);
		assert.strictEqual(extractTemplateCardEvent(frame), undefined);
	});

	test("授权卡片走主动推送，且 chat_type 必须显式给 1", () => {
		const parsed = JSON.parse(
			buildAuthorizeCardRequest("req-9", {
				taskId: "libiao-auth-abc",
				userId: "enc-user-1",
				computerName: "LibiaoCopilot",
				ttlMinutes: 5,
			})
		);
		assert.strictEqual(parsed.cmd, "aibot_send_msg");
		assert.strictEqual(parsed.headers.req_id, "req-9");
		assert.strictEqual(parsed.body.chatid, "enc-user-1");
		assert.strictEqual(parsed.body.chat_type, 1);
		assert.strictEqual(parsed.body.msgtype, "template_card");
		const card = parsed.body.template_card;
		assert.strictEqual(card.card_type, "button_interaction");
		assert.strictEqual(card.task_id, "libiao-auth-abc");
		assert.deepStrictEqual(
			card.button_list.map((button: { key: string }) => button.key),
			[WECHAT_BRIDGE_AUTH_ACCEPT_KEY, WECHAT_BRIDGE_AUTH_REJECT_KEY]
		);
		assert.strictEqual(card.button_list[0].text, "允许");
		assert.strictEqual(card.button_list[1].text, "拒绝");
	});

	test("卡片文本按文档限制截断，避免整条被服务端拒绝", () => {
		const parsed = JSON.parse(
			buildAuthorizeCardRequest("r", {
				taskId: "t",
				userId: "u",
				computerName: "超长的电脑名称".repeat(20),
				ttlMinutes: 1_440,
			})
		);
		const card = parsed.body.template_card;
		assert.ok(card.sub_title_text.length <= 112, `sub_title_text=${card.sub_title_text.length}`);
		assert.ok(card.horizontal_content_list[0].value.length <= 26);
		assert.ok(card.button_list[0].text.length <= 10);
	});

	test("结果卡片必须回显模板卡片事件的 req_id，并只剩一个无副作用的按钮", () => {
		const parsed = JSON.parse(
			buildAuthResultCardRequest("req-card-1", {
				taskId: "libiao-auth-abc",
				title: "已授权这台电脑",
				desc: "现在可以发消息了",
				accepted: true,
			})
		);
		assert.strictEqual(parsed.cmd, "aibot_respond_update_msg");
		assert.strictEqual(parsed.headers.req_id, "req-card-1");
		assert.strictEqual(parsed.body.response_type, "update_template_card");
		assert.strictEqual(parsed.body.template_card.task_id, "libiao-auth-abc");
		assert.deepStrictEqual(parsed.body.template_card.button_list, [
			{ text: "已处理", style: 1, key: WECHAT_BRIDGE_AUTH_DONE_KEY },
		]);
	});

	test("task_id 只用服务端允许的字符，且每次不同", () => {
		const first = createAuthorizeTaskId();
		const second = createAuthorizeTaskId();
		assert.ok(first.startsWith("libiao-auth-"));
		assert.match(first, /^[0-9A-Za-z_\-@]+$/);
		assert.ok(first.length <= 128);
		assert.notStrictEqual(first, second);
	});
});

suite("企微对话桥接设置", () => {
	test("空输入回落默认值，且默认不启用、不授权任何人", () => {
		const settings = sanitizeWechatBridgeSettings(undefined);
		assert.deepStrictEqual(settings, DEFAULT_WECHAT_BRIDGE_SETTINGS);
		assert.strictEqual(settings.enabled, false);
		assert.strictEqual(settings.allowedUserId, "");
	});

	test("超时秒数被夹到合法区间，非法注入位置回落当前会话", () => {
		const settings = sanitizeWechatBridgeSettings({
			respondTimeoutSeconds: 5,
			injectTarget: "nonsense" as never,
			allowedUserId: "  u1  ",
		});
		assert.strictEqual(settings.respondTimeoutSeconds, 30);
		assert.strictEqual(settings.injectTarget, "current");
		assert.strictEqual(settings.allowedUserId, "u1");
	});

	test("按字节截断不会切断 emoji", () => {
		assert.strictEqual(truncateUtf8("ab😀", 5), "ab");
		assert.strictEqual(truncateUtf8("ab😀", 6), "ab😀");
		assert.strictEqual(truncateUtf8("😀", 3), "");
	});

	test("群通知开关默认关闭，且只接受布尔值", () => {
		assert.strictEqual(DEFAULT_WECHAT_BRIDGE_SETTINGS.notifyGroupForBridgeTurns, false);
		assert.strictEqual(sanitizeWechatBridgeSettings(undefined).notifyGroupForBridgeTurns, false);
		assert.strictEqual(
			sanitizeWechatBridgeSettings({ notifyGroupForBridgeTurns: true }).notifyGroupForBridgeTurns,
			true
		);
		// 老版本存下来的配置里没有这个键，或界面传来字符串，都必须回落默认而不是被当成 true
		assert.strictEqual(
			sanitizeWechatBridgeSettings({ notifyGroupForBridgeTurns: "yes" as never }).notifyGroupForBridgeTurns,
			false
		);
	});

	test("超长回复截断到 20480 字节内并留下提示", () => {
		const long = "あ".repeat(30000);
		const fitted = fitWechatMessage(long);
		assert.ok(Buffer.byteLength(fitted, "utf8") <= WECHAT_BRIDGE_MESSAGE_MAX_BYTES);
		assert.ok(fitted.endsWith("完整结果请在 VS Code 中查看）"));
	});

	test("正常长度回复原样返回", () => {
		assert.strictEqual(fitWechatMessage("  **done**  "), "**done**");
	});

	test("prompt 归一化抹平空白差异，用于和落盘文本对齐", () => {
		assert.strictEqual(normalizePromptText("  跑\n  单测 "), "跑 单测");
	});
});

/**
 * 台账的消费者是 assets/hooks/WechatNotify.ps1：命中就说明这一轮已经回到企微了，不再推群通知。
 * 两边哈希规则必须一致，否则去重会静默失效（表现为同一个人被通知两遍）。
 */
suite("企微对话来源台账（供 Stop hook 去重）", () => {
	let tmpDir = "";

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libiao-ledger-"));
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("注入过的 prompt 能被命中", () => {
		appendBridgePromptRecord("跑一下单测", Date.now(), tmpDir);
		assert.strictEqual(isBridgeInjectedPrompt("跑一下单测", Date.now(), tmpDir), true);
	});

	test("没注入过的 prompt 不命中，避免误吞正常的群通知", () => {
		appendBridgePromptRecord("跑一下单测", Date.now(), tmpDir);
		assert.strictEqual(isBridgeInjectedPrompt("跑一下单测吧", Date.now(), tmpDir), false);
		assert.strictEqual(isBridgeInjectedPrompt("", Date.now(), tmpDir), false);
	});

	test("台账不存在时静默返回 false", () => {
		assert.strictEqual(fs.existsSync(bridgePromptLedgerPath(tmpDir)), false);
		assert.strictEqual(isBridgeInjectedPrompt("任意", Date.now(), tmpDir), false);
	});

	test("超过 TTL 的记录不再命中", () => {
		const at = Date.now();
		appendBridgePromptRecord("旧的一轮", at, tmpDir);
		assert.strictEqual(
			isBridgeInjectedPrompt("旧的一轮", at + BRIDGE_PROMPT_LEDGER_TTL_MS, tmpDir),
			true
		);
		assert.strictEqual(
			isBridgeInjectedPrompt("旧的一轮", at + BRIDGE_PROMPT_LEDGER_TTL_MS + 1, tmpDir),
			false
		);
	});

	test("哈希对齐 hook 侧规则：UTF-8 且先 trim", () => {
		const expected = createHash("sha256").update("跑一下单测", "utf8").digest("hex");
		assert.strictEqual(bridgePromptHash("  跑一下单测\n"), expected);
	});

	test("台账只存哈希，不落 prompt 原文", () => {
		appendBridgePromptRecord("这是不该落盘的内容", Date.now(), tmpDir);
		const content = fs.readFileSync(bridgePromptLedgerPath(tmpDir), "utf8");
		assert.ok(!content.includes("这是不该落盘的内容"));
		const record = JSON.parse(content.trim());
		assert.match(record.h, /^[0-9a-f]{64}$/);
		assert.strictEqual(typeof record.at, "number");
	});
});

suite("聊天会话日志重放与正文提取", () => {
	const requests = [
		{
			timestamp: 1000,
			message: { text: "第一个问题" },
			response: [{ kind: "thinking", value: "思考中" }, { value: "**第一轮**" }],
			result: { timings: { totalElapsed: 10 } },
		},
		{
			timestamp: 2000,
			message: { text: "第二个问题" },
			response: [{ value: "**第二轮**" }],
		},
	];

	test("kind 0 整体替换，kind 1/2/3 增量修改", () => {
		const session = replaySessionLog([
			JSON.stringify({ kind: 0, v: { requests: [], marker: 1 } }),
			JSON.stringify({ kind: 1, k: ["marker"], v: 2 }),
			JSON.stringify({ kind: 2, k: ["requests"], i: 0, v: [requests[0]] }),
			JSON.stringify({ kind: 2, k: ["requests"], v: [requests[1]] }),
			JSON.stringify({ kind: 3, k: ["marker"] }),
		]) as Record<string, unknown>;
		assert.strictEqual(session.marker, undefined);
		assert.strictEqual((session.requests as unknown[]).length, 2);
	});

	test("只拼接无 kind 的 string 部件，thinking 不算正文", () => {
		assert.strictEqual(extractAssistantMarkdown(requests[0].response), "**第一轮**");
		assert.strictEqual(extractAssistantMarkdown([{ kind: "thinking", value: "x" }]), "");
		assert.strictEqual(extractAssistantMarkdown(undefined), "");
	});

	test("按 prompt 命中本轮，并报告是否已完成", () => {
		const session = { requests };
		const first = findTurnByPrompt(session, "第一个问题", 0);
		assert.ok(first);
		assert.strictEqual(first.markdown, "**第一轮**");
		assert.strictEqual(first.completed, true);
		assert.strictEqual(first.matched, "exact");

		const second = findTurnByPrompt(session, "第二个问题", 0);
		assert.ok(second);
		assert.strictEqual(second.completed, false);
	});

	test("prompt 对不上时精确匹配返回 undefined，兜底取最近一轮", () => {
		const session = { requests };
		assert.strictEqual(findTurnByPrompt(session, "没问过的问题", 0), undefined);
		const latest = findLatestTurn(session, 0);
		assert.ok(latest);
		assert.strictEqual(latest.matched, "fallback");
		assert.strictEqual(latest.markdown, "**第二轮**");
	});

	test("早于注入时刻的历史轮次不算", () => {
		const session = { requests };
		assert.strictEqual(findTurnByPrompt(session, "第一个问题", 5000), undefined);
		assert.strictEqual(findLatestTurn(session, 5000), undefined);
	});

	test("增量尾部读取：分两次写入也能拼出完整会话", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libiao-bridge-"));
		const file = path.join(dir, "session.jsonl");
		try {
			const line0 = JSON.stringify({ kind: 0, v: { requests: [] } }) + "\n";
			fs.writeFileSync(file, line0, "utf8");
			const tail = new ChatSessionLogTail(file);
			tail.refresh();
			assert.deepStrictEqual(tail.snapshot, { requests: [] });

			// 第二个记录只写一半：此时不应被消费，也不应把 offset 推过去
			const line1 = JSON.stringify({ kind: 2, k: ["requests"], i: 0, v: [requests[0]] }) + "\n";
			fs.appendFileSync(file, line1.slice(0, 20), "utf8");
			tail.refresh();
			assert.deepStrictEqual(tail.snapshot, { requests: [] });

			fs.appendFileSync(file, line1.slice(20), "utf8");
			tail.refresh();
			const snapshot = tail.snapshot as { requests: unknown[] };
			assert.strictEqual(snapshot.requests.length, 1);
			assert.strictEqual(findTurnByPrompt(snapshot, "第一个问题", 0)?.markdown, "**第一轮**");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * 这条只在扩展宿主里联网跑，用来证明「ws 能在宿主进程里握手企微网关」。
 * 默认跳过（离线环境不该红），需要复验时：$env:LIBIAO_BRIDGE_LIVE="1"; npm test
 *
 * 用的是假的 bot_id/secret，所以网关一定拒绝订阅——但「收到带 errcode 的响应帧」
 * 就足以证明 TLS 握手、帧发送、帧解析三层都是通的；全局 WebSocket 那种 1006 直断不会走到这里。
 */
suite("企微对话长连接（真实网关，默认跳过）", () => {
	test("ws 能在扩展宿主里握手网关并收到订阅响应", async function () {
		if (process.env.LIBIAO_BRIDGE_LIVE !== "1") {
			this.skip();
		}
		const events: string[] = [];
		const connection = new WechatBridgeConnection("probe-bot-id", "probe-secret", {
			onFrame: () => undefined,
			onStateChange: (state, detail) => events.push(`${state}:${detail ?? ""}`),
			onDisconnectedEvent: () => undefined,
		});
		const reached = () => events.some((e) => e.startsWith("failed:订阅被拒绝") || e.startsWith("subscribed:"));
		try {
			connection.connect();
			const deadline = Date.now() + 15_000;
			while (!reached() && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			assert.ok(reached(), `没有收到订阅响应，实际事件：${events.join(" | ")}`);
		} finally {
			connection.disconnect();
		}
	});
});
