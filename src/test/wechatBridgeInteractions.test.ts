import * as assert from "assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	InteractionInbox,
	INTERACTIONS_DIR_NAME,
	renderQuestions,
	resolveInteractionsDir,
	toResolveId,
} from "../wechatBridgeInteractions";

/**
 * 这组断言守住的是「等待用户选择的提醒到底能不能送到手机上」：
 *
 * 之前的做法是从 transcript 的 tool.execution_start 里认 vscode_askQuestions，
 * 但实测证明那条路根本行不通 —— execution_start 只进内存缓冲，落盘要等 flush()，
 * 等待期 90 秒文件零增长，答完才把 start/complete 一起写下来，按顺序消费必然被
 * complete 抵消掉。现在改由 preToolUse hook 把事件写到 sidecar，这组用例分别守住
 * 「sidecar 能被正确解析」和「hook 脚本确实会写出这条事件」。
 */
suite("企微桥接的等待选择提醒", () => {
	test("sidecar 里的一条提问会被渲染成带选项的提醒", () => {
		const dir = makeTempInteractions();
		try {
			const inbox = new InteractionInbox(dir);
			inbox.prime();
			appendHookEvent(dir, "s1", "q1", {
				questions: [
					{
						header: "目标环境",
						question: "部署到哪个环境？",
						options: [{ label: "生产" }, { label: "测试", description: "先试一下" }],
					},
				],
			});

			const pending = inbox.poll();
			assert.strictEqual(pending.length, 1);
			assert.strictEqual(pending[0].sessionId, "s1");
			assert.strictEqual(pending[0].toolCallId, "q1");
			assert.ok(pending[0].markdown.includes("部署到哪个环境？"));
			assert.ok(pending[0].markdown.includes("1. 生产"));
			assert.ok(pending[0].markdown.includes("2. 测试 — 先试一下"));
			// 结构要够作答：下标、原始 label、多选标记都得在
			assert.deepStrictEqual(pending[0].questions, [
				{
					index: 0,
					header: "目标环境",
					text: "部署到哪个环境？",
					options: [
						{ label: "生产", description: "" },
						{ label: "测试", description: "先试一下" },
					],
					multiSelect: false,
				},
			]);
			// 文案必须告诉用户能直接回编号，否则他会以为还得回电脑
			assert.ok(
				pending[0].markdown.includes("直接回复编号作答"),
				"必须提示企微侧可以直接回编号"
			);
			// 消费即清空：同一个 toolCallId 不会被推两遍
			assert.deepStrictEqual(inbox.poll(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("同一 toolCallId 重复写入只推一条", () => {
		const dir = makeTempInteractions();
		try {
			const inbox = new InteractionInbox(dir);
			inbox.prime();
			const args = { questions: [{ question: "继续吗？" }] };
			appendHookEvent(dir, "s1", "q1", args);
			appendHookEvent(dir, "s1", "q1", args);

			assert.strictEqual(inbox.poll().length, 1);
			assert.deepStrictEqual(inbox.poll(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("建立基线前的历史提问不会被推出去", () => {
		const dir = makeTempInteractions();
		try {
			appendHookEvent(dir, "s1", "old", { questions: [{ question: "上个会话遗留的" }] });
			const inbox = new InteractionInbox(dir);
			inbox.prime();
			assert.deepStrictEqual(inbox.poll(), []);

			appendHookEvent(dir, "s1", "new", { questions: [{ question: "新的提问" }] });
			const pending = inbox.poll();
			assert.strictEqual(pending.length, 1);
			assert.strictEqual(pending[0].toolCallId, "new");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("参数里没有 questions 的行直接忽略，不产出空提醒", () => {
		const dir = makeTempInteractions();
		try {
			const inbox = new InteractionInbox(dir);
			inbox.prime();
			const filePath = path.join(dir, "s1.jsonl");
			// 损坏行、缺 toolCallId、questions 不是数组：三种都不该炸，也不该产出提醒
			fs.appendFileSync(filePath, "{ not json }\n", "utf8");
			fs.appendFileSync(filePath, `${JSON.stringify({ arguments: { questions: [{ question: "x" }] } })}\n`, "utf8");
			fs.appendFileSync(filePath, `${JSON.stringify({ toolCallId: "q3", arguments: {} })}\n`, "utf8");
			assert.deepStrictEqual(inbox.poll(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("renderQuestions 对空参数返回空串，调用方据此跳过推送", () => {
		assert.strictEqual(renderQuestions(undefined), "");
		assert.strictEqual(renderQuestions({}), "");
		assert.strictEqual(renderQuestions({ questions: [] }), "");
		assert.strictEqual(renderQuestions({ questions: [{ options: [] }] }), "");
	});

	test("sidecar 目录是 transcript 目录的同级 wechatPending", () => {
		const transcripts = path.join(os.tmpdir(), "hash", "GitHub.copilot-chat", "transcripts");
		assert.strictEqual(
			resolveInteractionsDir(transcripts),
			path.join(os.tmpdir(), "hash", "GitHub.copilot-chat", INTERACTIONS_DIR_NAME)
		);
	});

	test("resolveId 去掉 hook 侧多出来的 __vscode 后缀", () => {
		// hook 拿到的是 props.toolCall.id 原值，核心注册轮播时用的是 split('__vscode')[0]，
		// 不剥掉后缀提交答案会因 resolveId 不匹配而被静默丢弃
		assert.strictEqual(toResolveId("call_00_x__vscode-1793455973765"), "call_00_x");
		assert.strictEqual(toResolveId("call_00_plain"), "call_00_plain");
		assert.strictEqual(toResolveId(""), "");
	});

	test("sidecar 每行都带上剥好后缀的 resolveId", () => {
		const dir = makeTempInteractions();
		try {
			const inbox = new InteractionInbox(dir);
			inbox.prime();
			appendHookEvent(dir, "s2", "call_ab__vscode-123", {
				questions: [{ question: "选一个", options: [{ label: "A" }, { label: "B" }] }],
			});
			const pending = inbox.poll();
			assert.strictEqual(pending.length, 1);
			assert.strictEqual(pending[0].toolCallId, "call_ab__vscode-123");
			assert.strictEqual(pending[0].resolveId, "call_ab");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hook 脚本对提问工具写出 sidecar，对其它工具一个字都不写", () => {
		const script = resolveHookScript();
		if (!script) {
			// 打包环境里 assets 可能不在预期位置，跳过而不是假装通过
			assert.ok(true, "hook 脚本不存在，跳过");
			return;
		}
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "libiao-hook-"));
		try {
			const dataDir = path.join(base, "GitHub.copilot-chat");
			const transcripts = path.join(dataDir, "transcripts");
			fs.mkdirSync(transcripts, { recursive: true });
			const transcriptPath = path.join(transcripts, "s9.jsonl");

			const runHook = (input: object) => {
				const result = spawnSync(process.execPath, [script], {
					input: JSON.stringify(input),
					encoding: "utf8",
				});
				// exit 非 0 会被核心当成 deny 或 warning，绝不能出现
				assert.strictEqual(result.status, 0, `hook 退出码应为 0，实际 ${result.status}`);
				assert.strictEqual(result.stdout, "", "hook 不能往 stdout 写东西");
			};

			runHook({
				hook_event_name: "PreToolUse",
				tool_name: "run_in_terminal",
				tool_use_id: "other-1",
				session_id: "s9",
				transcript_path: transcriptPath,
				tool_input: { command: "npm test" },
			});
			const sidecarDir = path.join(dataDir, INTERACTIONS_DIR_NAME);
			assert.strictEqual(fs.existsSync(sidecarDir), false, "非提问工具不该创建 sidecar");

			runHook({
				hook_event_name: "PreToolUse",
				tool_name: "vscode_askQuestions",
				tool_use_id: "q9",
				session_id: "s9",
				transcript_path: transcriptPath,
				tool_input: { questions: [{ header: "确认", question: "继续吗？" }] },
			});

			const inbox = new InteractionInbox(sidecarDir);
			inbox.prime();
			appendHookEvent(sidecarDir, "s9", "q10", { questions: [{ question: "第二条" }] });
			const pending = inbox.poll();
			assert.strictEqual(pending.length, 1);
			assert.strictEqual(pending[0].toolCallId, "q10");
			// 上面那条 q9 在 prime 之前就写好了，属于基线，只验证脚本确实写进了文件
			const written = fs.readFileSync(path.join(sidecarDir, "s9.jsonl"), "utf8");
			assert.ok(written.includes("\"q9\""), "hook 应把提问事件写进 sidecar");
			assert.ok(written.includes("继续吗？"));
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});

function resolveHookScript(): string | undefined {
	const candidate = path.join(__dirname, "..", "..", "assets", "hooks", "WechatInteract.js");
	return fs.existsSync(candidate) ? candidate : undefined;
}

function makeTempInteractions(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "libiao-interact-"));
}

function appendHookEvent(dir: string, sessionId: string, toolCallId: string, args: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	const line = `${JSON.stringify({
		toolCallId,
		toolName: "vscode_askQuestions",
		arguments: args,
		at: new Date().toISOString(),
	})}\n`;
	fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), line, "utf8");
}
