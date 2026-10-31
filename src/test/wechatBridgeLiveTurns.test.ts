import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMarkdownSendRequest } from "../wechatBridgeProtocol";
import { LIVE_TURN_IDLE_MS, LiveTurnScanner, resolveTranscriptsDir } from "../wechatBridgeLiveTurns";

/**
 * 这组断言守住的是「正文取错地方就会静默推错内容」的几条：
 * - 主动推送必须走 aibot_send_msg + msgtype=markdown + chat_type=1
 *   （不填 chat_type 会被服务端优先按群聊处理，文档 101837）
 * - 一次请求在 transcript 里会拆成多个 assistant.turn_end，只有静默后才是真结束
 * - 正文只来自 assistant.message.content，工具事件与空串不能混进去
 */
suite("企微对话桥接的实时轮次", () => {
	test("主动推送帧带 chatid / chat_type=1 / msgtype=markdown", () => {
		const parsed = JSON.parse(buildMarkdownSendRequest("req-9", "user-abc", "# 标题\n正文"));
		assert.strictEqual(parsed.cmd, "aibot_send_msg");
		assert.strictEqual(parsed.headers.req_id, "req-9");
		assert.strictEqual(parsed.body.chatid, "user-abc");
		assert.strictEqual(parsed.body.chat_type, 1);
		assert.strictEqual(parsed.body.msgtype, "markdown");
		assert.strictEqual(parsed.body.markdown.content, "# 标题\n正文");
		// stream 是回复消息专用，主动推送带它会被拒
		assert.strictEqual(parsed.body.stream, undefined);
	});

	test("transcript 里的多段 turn 合成一轮，正文只取 assistant.message.content", () => {
		const dir = makeTempTranscripts();
		try {
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			appendEvents(dir, "s1", [
				userMessage("帮我看下构建"),
				turnStart("t1"),
				assistantMessage("我先查一下配置。"),
				turnEnd(),
				turnStart("t2"),
				toolStart(),
				toolComplete(),
				assistantMessage(""), // 只发工具调用的空消息，不能当成正文
				turnEnd(),
				turnStart("t3"),
				assistantMessage("构建命令是 npm run build。"),
				turnEnd(),
			]);

			const turns = scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(turns.length, 1);
			assert.strictEqual(turns[0].sessionId, "s1");
			assert.strictEqual(turns[0].prompt, "帮我看下构建");
			assert.strictEqual(turns[0].markdown, "我先查一下配置。\n\n构建命令是 npm run build。");
			// 消费即清空：同一次结束不会被推两遍
			assert.deepStrictEqual(scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("最后一个 turn_end 之后没静默够就不算结束", () => {
		const dir = makeTempTranscripts();
		try {
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			appendEvents(dir, "s1", [
				userMessage("继续"),
				turnStart("t1"),
				assistantMessage("还在跑。"),
				turnEnd(),
			]);
			// 用「刚结束」的时刻去 poll：需要等下一个 step，不能判完成
			assert.deepStrictEqual(scanner.poll(Date.now()), []);
			const turns = scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(turns.length, 1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("建立基线前的历史轮次不会被当成新轮次", () => {
		const dir = makeTempTranscripts();
		try {
			appendEvents(dir, "s1", [
				userMessage("历史问题"),
				turnStart("t1"),
				assistantMessage("历史回答"),
				turnEnd(),
			]);
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			assert.deepStrictEqual(scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2), []);

			appendEvents(dir, "s1", [
				userMessage("新问题"),
				turnStart("t2"),
				assistantMessage("新回答"),
				turnEnd(),
			]);
			const turns = scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(turns.length, 1);
			assert.strictEqual(turns[0].prompt, "新问题");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hasPendingPrompt 只观察不消费", () => {
		const dir = makeTempTranscripts();
		try {
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			appendEvents(dir, "s1", [userMessage("在跑的任务"), turnStart("t1"), assistantMessage("中间结果")]);
			scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(scanner.hasPendingPrompt("在跑的任务"), true);
			assert.strictEqual(scanner.hasPendingPrompt("别的问题"), false);
			// 观察不该把轮次吃掉
			appendEvents(dir, "s1", [turnEnd()]);
			const turns = scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(turns.length, 1);
			assert.strictEqual(scanner.hasPendingPrompt("在跑的任务"), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("isBusy 区分「正在跑」与「空闲」，避免把注入排队误判成失败", () => {
		const dir = makeTempTranscripts();
		try {
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			assert.strictEqual(scanner.isBusy(), false);
			appendEvents(dir, "s1", [userMessage("上一轮还没跑完"), turnStart("t1"), assistantMessage("先做点事")]);
			scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			// 上一轮在跑时新注入的 prompt 还没出现，这是排队而不是失败
			assert.strictEqual(scanner.isBusy(), true);
			assert.strictEqual(scanner.hasPendingPrompt("新注入的"), false);
			appendEvents(dir, "s1", [turnEnd()]);
			scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(scanner.isBusy(), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("子代理的 prompt 与正文都不属于本轮", () => {
		const dir = makeTempTranscripts();
		try {
			const scanner = new LiveTurnScanner(dir);
			scanner.prime();
			appendEvents(dir, "s1", [
				userMessage("帮我查一下企微桥接"),
				turnStart("t1"),
				toolStartOf("call_sub", "runSubagent"),
				// 子代理自己的 prompt 和正文都写进同一个文件，混进来就会提前把主轮收掉
				userMessage("子代理的任务描述"),
				turnStart("t0"),
				assistantMessage("我先看看相关文件。"),
				toolStartOf("call_inner", "read_file"),
				toolCompleteOf("call_inner"),
				turnEnd(),
				assistantMessage("# 子代理的完整调研报告"),
				turnEnd(),
				toolCompleteOf("call_sub"),
				assistantMessage("这是本轮真正的回答。"),
				turnEnd(),
			]);

			const turns = scanner.poll(Date.now() + LIVE_TURN_IDLE_MS * 2);
			assert.strictEqual(turns.length, 1);
			assert.strictEqual(turns[0].prompt, "帮我查一下企微桥接");
			assert.strictEqual(turns[0].markdown, "这是本轮真正的回答。");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolveTranscriptsDir 认得 <hash>/GitHub.copilot-chat/transcripts", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "libiao-live-"));
		try {
			const chatSessions = path.join(base, "chatSessions");
			fs.mkdirSync(chatSessions, { recursive: true });
			assert.strictEqual(resolveTranscriptsDir(chatSessions), undefined);

			const expected = path.join(base, "GitHub.copilot-chat", "transcripts");
			fs.mkdirSync(expected, { recursive: true });
			assert.strictEqual(resolveTranscriptsDir(chatSessions), expected);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});

function makeTempTranscripts(): string {
	clock = 0;
	return fs.mkdtempSync(path.join(os.tmpdir(), "libiao-live-"));
}

let clock = 0;

function stamp(): string {
	clock += 1;
	return new Date(Date.now() + clock).toISOString();
}

function appendEvents(dir: string, sessionId: string, events: object[]): void {
	const filePath = path.join(dir, `${sessionId}.jsonl`);
	const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
	fs.appendFileSync(filePath, body, "utf8");
}

function userMessage(content: string): object {
	return { type: "user.message", data: { content }, timestamp: stamp() };
}

function turnStart(turnId: string): object {
	return { type: "assistant.turn_start", data: { turnId }, timestamp: stamp() };
}

function assistantMessage(content: string): object {
	return { type: "assistant.message", data: { messageId: `m-${content.length}`, content }, timestamp: stamp() };
}

function turnEnd(): object {
	return { type: "assistant.turn_end", data: {}, timestamp: stamp() };
}

function toolStart(): object {
	return { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "read_file" }, timestamp: stamp() };
}

function toolComplete(): object {
	return { type: "tool.execution_complete", data: { toolCallId: "c1", success: true }, timestamp: stamp() };
}

function toolStartOf(toolCallId: string, toolName: string, args?: unknown): object {
	return {
		type: "tool.execution_start",
		data: { toolCallId, toolName, arguments: args ?? {} },
		timestamp: stamp(),
	};
}

function toolCompleteOf(toolCallId: string): object {
	return { type: "tool.execution_complete", data: { toolCallId, success: true }, timestamp: stamp() };
}
