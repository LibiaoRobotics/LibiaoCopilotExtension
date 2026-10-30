import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { OllamaApi } from "../ollama/ollamaApi";
import { GeminiApi } from "../gemini/geminiApi";
import { getGitDiff } from "../gitCommit/gitUtils";
import { CommitStreamChunk } from "../commonApi";
import { HFModelItem } from "../types";

const execFileAsync = promisify(execFile);

/**
 * 回归测试套件：提交信息生成
 * 覆盖两份历史缺陷：
 * 1. 「明明有改动却提示没有改动」—— 改动收集（未跟踪/删除/无 HEAD/暂存+未暂存）
 * 2. 「生成的提交信息后面断了一截」—— 流收尾补齐与截断识别
 */

suite("getGitDiff 待提交改动收集", () => {
	const createdDirs: string[] = [];

	async function git(cwd: string, args: string[]): Promise<string> {
		const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	}

	async function commitAll(cwd: string, message: string): Promise<void> {
		await git(cwd, [
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Libiao Test",
			"commit",
			"-m",
			message,
			"--quiet",
		]);
	}

	async function createRepo(): Promise<string> {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libiao-git-")));
		createdDirs.push(dir);
		await git(dir, ["init", "--quiet"]);
		return dir;
	}

	teardown(() => {
		while (createdDirs.length > 0) {
			const dir = createdDirs.pop();
			if (!dir) {
				continue;
			}
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// 清理失败不影响测试结论
			}
		}
	});

	test("只有未跟踪文件时也能收集到 diff", async () => {
		const dir = await createRepo();
		fs.writeFileSync(path.join(dir, "untracked.txt"), "hello untracked\n", "utf8");

		const diff = await getGitDiff(dir);

		assert.ok(diff.includes("untracked.txt"), `应包含未跟踪文件名，实际输出：\n${diff}`);
		assert.ok(diff.includes("+hello untracked"), `应包含未跟踪文件内容，实际输出：\n${diff}`);
	});

	test("删除文件不会被 --diff-filter=d 过滤掉", async () => {
		const dir = await createRepo();
		fs.writeFileSync(path.join(dir, "gone.txt"), "will be removed\n", "utf8");
		await git(dir, ["add", "gone.txt"]);
		await commitAll(dir, "init");
		fs.rmSync(path.join(dir, "gone.txt"));

		const diff = await getGitDiff(dir);

		assert.ok(diff.includes("gone.txt"), `应包含被删除的文件名，实际输出：\n${diff}`);
		assert.ok(diff.includes("-will be removed"), `应包含删除行，实际输出：\n${diff}`);
	});

	test("仓库尚无任何提交（无 HEAD）时也能生成 diff", async () => {
		const dir = await createRepo();
		fs.writeFileSync(path.join(dir, "first.txt"), "first commit content\n", "utf8");
		await git(dir, ["add", "first.txt"]);

		const diff = await getGitDiff(dir);

		assert.ok(diff.includes("first.txt"), `应包含已暂存的新文件，实际输出：\n${diff}`);
		assert.ok(diff.includes("+first commit content"), `应包含新增内容，实际输出：\n${diff}`);
	});

	test("暂存改动与未暂存改动同时上报", async () => {
		const dir = await createRepo();
		fs.writeFileSync(path.join(dir, "a.txt"), "base\n", "utf8");
		await git(dir, ["add", "a.txt"]);
		await commitAll(dir, "init");

		fs.writeFileSync(path.join(dir, "a.txt"), "base\nstaged line\n", "utf8");
		await git(dir, ["add", "a.txt"]);
		fs.writeFileSync(path.join(dir, "a.txt"), "base\nstaged line\nunstaged line\n", "utf8");

		const diff = await getGitDiff(dir);

		assert.ok(diff.includes("已暂存改动"), `应包含已暂存段落，实际输出：\n${diff}`);
		assert.ok(diff.includes("未暂存改动"), `应包含未暂存段落，实际输出：\n${diff}`);
		assert.ok(diff.includes("+staged line"), `应包含暂存行，实际输出：\n${diff}`);
		assert.ok(diff.includes("+unstaged line"), `应包含未暂存行，实际输出：\n${diff}`);
	});

	test("确实没有改动时返回空字符串", async () => {
		const dir = await createRepo();
		fs.writeFileSync(path.join(dir, "a.txt"), "base\n", "utf8");
		await git(dir, ["add", "a.txt"]);
		await commitAll(dir, "init");

		assert.strictEqual(await getGitDiff(dir), "");
	});

	test("非 Git 仓库抛出可读错误而不是「没有改动」", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libiao-nogit-")));
		createdDirs.push(dir);

		await assert.rejects(
			async () => getGitDiff(dir),
			(error: Error) => error.message.includes("不是 Git 仓库")
		);
	});
});

suite("createMessage 流收尾与截断识别", () => {
	const testModel = { id: "test-model", displayName: "test", owned_by: "test" } as HFModelItem;

	function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});
	}

	function mockFetch(stream: ReadableStream<Uint8Array>): () => void {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
		return () => {
			globalThis.fetch = original;
		};
	}

	async function collect(generator: AsyncGenerator<CommitStreamChunk>) {
		let text = "";
		let incomplete: string | undefined;
		for await (const chunk of generator) {
			if (chunk.type === "text") {
				text += chunk.text;
			} else if (chunk.type === "replace") {
				text = chunk.text;
			} else {
				incomplete = chunk.reason;
			}
		}
		return { text, incomplete };
	}

	test("chat：末尾没有换行的最后一段 delta 不会丢", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"choices":[{"delta":{"content":"feat: 新增"}}]}\n\n`,
				`data: {"choices":[{"delta":{"content":"生成逻辑"}}]}`,
			])
		);
		try {
			const api = new OpenaiApi("test-model");
			const { text, incomplete } = await collect(
				api.createMessage(testModel, "", [{ role: "user", content: "diff" }], "https://example.com/v1", "key")
			);
			assert.strictEqual(text, "feat: 新增生成逻辑");
			assert.strictEqual(incomplete, "unexpected-end");
		} finally {
			restore();
		}
	});

	test("chat：finish_reason=length 时报告截断", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"choices":[{"delta":{"content":"feat: 半截"}}]}\n\n`,
				`data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`,
			])
		);
		try {
			const api = new OpenaiApi("test-model");
			const { text, incomplete } = await collect(
				api.createMessage(testModel, "", [{ role: "user", content: "diff" }], "https://example.com/v1", "key")
			);
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "length");
		} finally {
			restore();
		}
	});

	test("chat：正常结束（finish_reason=stop + [DONE]）不报告异常", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"choices":[{"delta":{"content":"feat: 完成"}}]}\n\n`,
				`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
				`data: [DONE]\n\n`,
			])
		);
		try {
			const api = new OpenaiApi("test-model");
			const { text, incomplete } = await collect(
				api.createMessage(testModel, "", [{ role: "user", content: "diff" }], "https://example.com/v1", "key")
			);
			assert.strictEqual(text, "feat: 完成");
			assert.strictEqual(incomplete, undefined);
		} finally {
			restore();
		}
	});

	test("responses：done 事件里的权威全文补齐被吞掉的尾部", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"response.output_text.delta","delta":"feat: 新增"}\n\n`,
				`data: {"type":"response.output_text.done","text":"feat: 新增提交信息生成"}\n\n`,
				`data: {"type":"response.completed","response":{"output":[]}}\n\n`,
			])
		);
		try {
			const api = new OpenaiResponsesApi("test-model");
			const { text, incomplete } = await collect(
				api.createMessage(testModel, "", [{ role: "user", content: "diff" }], "https://example.com/v1", "key")
			);
			assert.strictEqual(text, "feat: 新增提交信息生成");
			assert.strictEqual(incomplete, undefined);
		} finally {
			restore();
		}
	});

	test("responses：response.incomplete 报告截断", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"response.output_text.delta","delta":"feat: 半截"}\n\n`,
				`data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n`,
			])
		);
		try {
			const api = new OpenaiResponsesApi("test-model");
			const { text, incomplete } = await collect(
				api.createMessage(testModel, "", [{ role: "user", content: "diff" }], "https://example.com/v1", "key")
			);
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "length");
		} finally {
			restore();
		}
	});
});

/**
 * 各协议 createMessage 的收尾校验：正常结束不得报警，服务端截断与意外断连必须报警。
 * 历史缺口：anthropic / ollama 只收正文、不看终止信号，gemini 完全没有实现。
 */
suite("createMessage 多协议收尾校验", () => {
	const testModel = { id: "test-model", displayName: "test", owned_by: "test" } as HFModelItem;

	function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});
	}

	function mockFetch(stream: ReadableStream<Uint8Array>): () => void {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
		return () => {
			globalThis.fetch = original;
		};
	}

	async function collect(generator: AsyncGenerator<CommitStreamChunk>) {
		let text = "";
		let incomplete: string | undefined;
		for await (const chunk of generator) {
			if (chunk.type === "text") {
				text += chunk.text;
			} else if (chunk.type === "replace") {
				text = chunk.text;
			} else {
				incomplete = chunk.reason;
			}
		}
		return { text, incomplete };
	}

	async function run(
		api: {
			createMessage: (
				model: HFModelItem,
				systemPrompt: string,
				messages: { role: string; content: string }[],
				baseUrl: string,
				apiKey: string,
				signal?: AbortSignal
			) => AsyncGenerator<CommitStreamChunk>;
		},
		baseUrl: string
	) {
		return collect(api.createMessage(testModel, "", [{ role: "user", content: "diff" }], baseUrl, "key"));
	}

	test("anthropic：message_stop 正常结束不报告异常", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"feat: 新增"}}\n\n`,
				`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n`,
				`data: {"type":"message_stop"}\n\n`,
			])
		);
		try {
			const { text, incomplete } = await run(new AnthropicApi("test-model"), "https://example.com/v1");
			assert.strictEqual(text, "feat: 新增");
			assert.strictEqual(incomplete, undefined);
		} finally {
			restore();
		}
	});

	test("anthropic：stop_reason=max_tokens 报告截断", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"feat: 半截"}}\n\n`,
				`data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null}}\n\n`,
				`data: {"type":"message_stop"}\n\n`,
			])
		);
		try {
			const { text, incomplete } = await run(new AnthropicApi("test-model"), "https://example.com/v1");
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "length");
		} finally {
			restore();
		}
	});

	test("anthropic：未收到终止信号就断连报告 unexpected-end，且尾部无换行的分片不丢", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"feat: 新增"}}\n\n`,
				`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"生成逻辑"}}`,
			])
		);
		try {
			const { text, incomplete } = await run(new AnthropicApi("test-model"), "https://example.com/v1");
			assert.strictEqual(text, "feat: 新增生成逻辑");
			assert.strictEqual(incomplete, "unexpected-end");
		} finally {
			restore();
		}
	});

	test("anthropic：流内 error 事件报告 failed", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"feat: 半截"}}\n\n`,
				`data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
			])
		);
		try {
			const { incomplete } = await run(new AnthropicApi("test-model"), "https://example.com/v1");
			assert.strictEqual(incomplete, "failed");
		} finally {
			restore();
		}
	});

	test("ollama：done_reason=stop 正常结束不报告异常", async () => {
		const restore = mockFetch(
			sseStream([
				`{"message":{"role":"assistant","content":"feat: 新增"},"done":false}\n`,
				`{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n`,
			])
		);
		try {
			const { text, incomplete } = await run(new OllamaApi("test-model"), "https://example.com");
			assert.strictEqual(text, "feat: 新增");
			assert.strictEqual(incomplete, undefined);
		} finally {
			restore();
		}
	});

	test("ollama：done_reason=length 报告截断", async () => {
		const restore = mockFetch(
			sseStream([
				`{"message":{"role":"assistant","content":"feat: 半截"},"done":false}\n`,
				`{"message":{"role":"assistant","content":""},"done":true,"done_reason":"length"}\n`,
			])
		);
		try {
			const { incomplete } = await run(new OllamaApi("test-model"), "https://example.com");
			assert.strictEqual(incomplete, "length");
		} finally {
			restore();
		}
	});

	test("ollama：流内 error 字段报告 failed，且末尾无换行的分片不丢", async () => {
		const restore = mockFetch(
			sseStream([`{"message":{"role":"assistant","content":"feat: 半截"},"done":false}\n`, `{"error":"model not found"}`])
		);
		try {
			const { text, incomplete } = await run(new OllamaApi("test-model"), "https://example.com");
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "failed");
		} finally {
			restore();
		}
	});

	test("gemini：finishReason=STOP 正常结束，累积快照折算为增量", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"candidates":[{"content":{"parts":[{"text":"feat: 新增"}]}}]}\n\n`,
				`data: {"candidates":[{"content":{"parts":[{"text":"feat: 新增提交信息"}]},"finishReason":"STOP"}]}\n\n`,
			])
		);
		try {
			const { text, incomplete } = await run(new GeminiApi("test-model"), "https://example.com/v1beta");
			assert.strictEqual(text, "feat: 新增提交信息");
			assert.strictEqual(incomplete, undefined);
		} finally {
			restore();
		}
	});

	test("gemini：finishReason=MAX_TOKENS 报告截断", async () => {
		const restore = mockFetch(
			sseStream([`data: {"candidates":[{"content":{"parts":[{"text":"feat: 半截"}]},"finishReason":"MAX_TOKENS"}]}\n\n`])
		);
		try {
			const { text, incomplete } = await run(new GeminiApi("test-model"), "https://example.com/v1beta");
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "length");
		} finally {
			restore();
		}
	});

	test("gemini：内容安全拦截报告 failed，思考分片不进正文", async () => {
		const restore = mockFetch(
			sseStream([
				`data: {"candidates":[{"content":{"parts":[{"text":"省略的思考","thought":true}]}}]}\n\n`,
				`data: {"candidates":[{"content":{"parts":[{"text":"feat: 半截"}]},"finishReason":"SAFETY"}]}\n\n`,
			])
		);
		try {
			const { text, incomplete } = await run(new GeminiApi("test-model"), "https://example.com/v1beta");
			assert.strictEqual(text, "feat: 半截");
			assert.strictEqual(incomplete, "failed");
		} finally {
			restore();
		}
	});
});
