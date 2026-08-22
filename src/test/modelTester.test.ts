import * as assert from "assert";
import * as vscode from "vscode";
import {
	buildResult,
	buildTestRequestBody,
	buildTestUrl,
	consumeStream,
	estimateTokens,
	extractDeltaChars,
	extractUsage,
	testSingleModel,
	type ModelTestResult,
} from "../modelTester";
import type { HFModelItem } from "../types";

/**
 * modelTester 纯函数单测：
 * - buildTestUrl / buildTestRequestBody：各 apiMode 的请求路径与 body 组装
 * - extractUsage / extractDeltaChars：5 协议的真实响应字段解析
 * - buildResult：TTFT/TPS 计算与边界
 * - consumeStream：SSE 与 Ollama 纯 JSON line 流解析
 * - testSingleModel：mock 全局 fetch 的完整流程
 */

/** 构造 SSE 流（带 data: 前缀，[DONE] 结尾） */
function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
	const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
}

/** 构造 Ollama 纯 JSON line 流（无 data: 前缀） */
function jsonLineStream(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
	const payload = chunks.map((c) => JSON.stringify(c) + "\n").join("");
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
}

suite("modelTester", () => {
	suite("buildTestUrl", () => {
		test("openai: /chat/completions", () => {
			assert.strictEqual(buildTestUrl("https://gw.example.com/v1", "openai", "m1"), "https://gw.example.com/v1/chat/completions");
		});

		test("openai-responses: /responses", () => {
			assert.strictEqual(buildTestUrl("https://gw.example.com/v1", "openai-responses", "m1"), "https://gw.example.com/v1/responses");
		});

		test("anthropic: /messages", () => {
			assert.strictEqual(buildTestUrl("https://gw.example.com", "anthropic", "m1"), "https://gw.example.com/messages");
		});

		test("ollama: /api/chat", () => {
			assert.strictEqual(buildTestUrl("http://127.0.0.1:11434", "ollama", "m1"), "http://127.0.0.1:11434/api/chat");
		});

		test("gemini: streamGenerateContent with alt=sse", () => {
			const url = buildTestUrl("https://generativelanguage.googleapis.com", "gemini", "gemini-2.5-pro");
			assert.ok(url.includes("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"));
		});

		test("trailing slash 被归一化", () => {
			assert.strictEqual(buildTestUrl("https://gw.example.com/v1/", "openai", "m1"), "https://gw.example.com/v1/chat/completions");
		});

		test("gemini 无效 baseUrl 抛错", () => {
			assert.throws(() => buildTestUrl("", "gemini", "m1"), /无效/);
		});
	});

	suite("buildTestRequestBody", () => {
		const model: HFModelItem = { id: "m1", owned_by: "libiaorobot" };

		test("openai: stream + stream_options.include_usage + max_tokens", () => {
			const body = buildTestRequestBody(model, "openai");
			assert.strictEqual(body.stream, true);
			assert.deepStrictEqual(body.stream_options, { include_usage: true });
			assert.strictEqual(body.max_tokens, 1100);
			assert.strictEqual(body.model, "m1");
		});

		test("openai-responses: input + max_output_tokens", () => {
			const body = buildTestRequestBody(model, "openai-responses");
			assert.strictEqual(body.stream, true);
			assert.strictEqual(body.max_output_tokens, 1100);
			assert.strictEqual(body.model, "m1");
		});

		test("anthropic: max_tokens 且有 stream", () => {
			const body = buildTestRequestBody(model, "anthropic");
			assert.strictEqual(body.stream, true);
			assert.strictEqual(body.max_tokens, 1100);
			assert.strictEqual(body.model, "m1");
		});

		test("gemini: 无 stream 字段（URL 控制流式），maxOutputTokens=1100", () => {
			const body = buildTestRequestBody(model, "gemini");
			assert.ok(!("stream" in body), "gemini body 不应含 stream 字段");
			assert.strictEqual((body.generationConfig as Record<string, unknown>).maxOutputTokens, 1100);
		});

		test("ollama: options.num_predict=1100", () => {
			const body = buildTestRequestBody(model, "ollama");
			assert.strictEqual(body.stream, true);
			assert.strictEqual((body.options as Record<string, unknown>).num_predict, 1100);
		});
	});

	suite("extractUsage", () => {
		test("OpenAI chat: 顶层 usage", () => {
			const usage = extractUsage({
				usage: { prompt_tokens: 12, completion_tokens: 1000, total_tokens: 1012 },
			});
			assert.deepStrictEqual(usage, { prompt_tokens: 12, completion_tokens: 1000, total_tokens: 1012 });
		});

		test("OpenAI Responses: response.completed 的 usage（output_tokens/input_tokens）", () => {
			const usage = extractUsage({
				type: "response.completed",
				response: { usage: { input_tokens: 20, output_tokens: 1000 } },
			});
			assert.deepStrictEqual(usage, { prompt_tokens: 20, completion_tokens: 1000, total_tokens: 1020 });
		});

		test("Anthropic: message_delta 的 usage（含 cache tokens 叠加）", () => {
			const usage = extractUsage({
				type: "message_delta",
				usage: {
					input_tokens: 10,
					output_tokens: 999,
					cache_creation_input_tokens: 5,
					cache_read_input_tokens: 3,
				},
			});
			assert.deepStrictEqual(usage, { prompt_tokens: 18, completion_tokens: 999, total_tokens: 1017 });
		});

		test("Gemini: usageMetadata", () => {
			const usage = extractUsage({
				usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 900, totalTokenCount: 930 },
			});
			assert.deepStrictEqual(usage, { prompt_tokens: 30, completion_tokens: 900, total_tokens: 930 });
		});

		test("Ollama: done 事件的 eval_count", () => {
			const usage = extractUsage({
				done: true,
				prompt_eval_count: 8,
				eval_count: 1000,
			});
			assert.deepStrictEqual(usage, { prompt_tokens: 8, completion_tokens: 1000, total_tokens: 1008 });
		});

		test("无 usage 字段返回 undefined", () => {
			assert.strictEqual(extractUsage({ type: "message_start" }), undefined);
		});
	});

	suite("extractDeltaChars", () => {
		test("OpenAI chat delta.content", () => {
			assert.strictEqual(extractDeltaChars({ delta: { content: "你好" } }), 2);
		});

		test("OpenAI chat delta.text 兜底", () => {
			assert.strictEqual(extractDeltaChars({ delta: { text: "abc" } }), 3);
		});

		test("OpenAI Responses delta 字符串", () => {
			assert.strictEqual(extractDeltaChars({ type: "response.output_text.delta", delta: "hello" }), 5);
		});

		test("Anthropic content_block_delta.delta.text 不重复计数", () => {
			assert.strictEqual(extractDeltaChars({ type: "content_block_delta", delta: { text: "世界" } }), 2);
		});

		test("Gemini candidates parts text", () => {
			assert.strictEqual(
				extractDeltaChars({ candidates: [{ content: { parts: [{ text: "ab" }, { text: "cd" }] } }] }),
				4
			);
		});

		test("Ollama message.content", () => {
			assert.strictEqual(extractDeltaChars({ message: { content: "xyz" } }), 3);
		});

		test("未知格式返回 0", () => {
			assert.strictEqual(extractDeltaChars({ foo: "bar" }), 0);
		});
	});

	suite("estimateTokens", () => {
		test("字符数 * 0.6 取整", () => {
			assert.strictEqual(estimateTokens(100), 60);
			assert.strictEqual(estimateTokens(101), 61);
		});

		test("最小为 1（非 0 输入）", () => {
			assert.strictEqual(estimateTokens(1), 1);
		});

		test("0 或负数返回 0", () => {
			assert.strictEqual(estimateTokens(0), 0);
			assert.strictEqual(estimateTokens(-5), 0);
		});
	});

	suite("buildResult", () => {
		test("成功：TTFT=500ms，TPS = tokens/generateMs", () => {
			// requestStart 为 1s 前，firstEventAt 为 0.5s 前 → TTFT=500ms
			// 生成耗时 ≈ (now - firstEventAt)，必然 >= 生成开始时刻距 now 的时长
			const s = { requestStart: Date.now() - 1000, firstEventAt: Date.now() - 500, outputChars: 1600, lastReadAt: Date.now() };
			const r = buildResult("m1", s, { ok: true, usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 } });
			assert.strictEqual(r.ok, true);
			assert.strictEqual(r.ttftMs, 500);
			assert.strictEqual(r.outputTokens, 200);
			// generateMs ≈ 500~600ms（受 Date.now() 时序波动），TPS ≈ 200/0.5s
			assert.ok((r.generateMs ?? 0) >= 450 && (r.generateMs ?? 0) <= 700);
			assert.ok((r.tps ?? 0) >= 250 && (r.tps ?? 0) <= 450);
		});

		test("成功：无 usage 时按字符估算", () => {
			const s = { requestStart: Date.now() - 1000, firstEventAt: Date.now() - 500, outputChars: 1600, lastReadAt: Date.now() };
			const r = buildResult("m1", s, { ok: true, usage: undefined });
			assert.strictEqual(r.ok, true);
			assert.strictEqual(r.outputTokens, estimateTokens(1600));
		});

		test("成功：usage 与估算同时存在时优先 usage", () => {
			const s = { requestStart: Date.now() - 1000, firstEventAt: Date.now() - 500, outputChars: 1600, lastReadAt: Date.now() };
			const r = buildResult("m1", s, {
				ok: true,
				usage: { prompt_tokens: 10, completion_tokens: 999, total_tokens: 1009 },
			});
			assert.strictEqual(r.outputTokens, 999);
		});

		test("成功：流无事件（ttftMs=null）判失败", () => {
			const s = { requestStart: 1000, firstEventAt: null, outputChars: 0, lastReadAt: 0 };
			const r = buildResult("m1", s, { ok: true, usage: undefined });
			assert.strictEqual(r.ok, false);
			assert.match(r.error || "", /流未返回任何内容/);
		});

		test("失败：输出 0 token 判失败（避免 TPS=0 误导）", () => {
			const s = { requestStart: Date.now() - 1000, firstEventAt: Date.now() - 500, outputChars: 0, lastReadAt: Date.now() };
			const r = buildResult("m1", s, { ok: true, usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } });
			assert.strictEqual(r.ok, false);
			assert.match(r.error || "", /可计数/);
		});

		test("失败：携带 error 且无 ttft", () => {
			const s = { requestStart: 1000, firstEventAt: null, outputChars: 0, lastReadAt: 0 };
			const r = buildResult("m1", s, { ok: false, error: "[500] Internal Server Error" });
			assert.strictEqual(r.ok, false);
			assert.strictEqual(r.error, "[500] Internal Server Error");
			assert.strictEqual(r.ttftMs, undefined);
		});
	});

	suite("consumeStream", () => {
		test("SSE 流：提取 usage 并累计字符", async () => {
			const stream = sseStream([
				{ delta: { content: "Hello" } },
				{ delta: { content: " world" } },
				{ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
			]);
			const state = { requestStart: Date.now(), firstEventAt: null, outputChars: 0, lastReadAt: Date.now() };
			const token = new vscode.CancellationTokenSource().token;
			const usage = await consumeStream(stream, state, token);
			assert.deepStrictEqual(usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
			assert.strictEqual(state.outputChars, 11);
			assert.notStrictEqual(state.firstEventAt, null);
		});

		test("Ollama 纯 JSON line 流（无 data: 前缀）", async () => {
			const stream = jsonLineStream([
				{ message: { content: "abc" } },
				{ done: true, prompt_eval_count: 3, eval_count: 100 },
			]);
			const state = { requestStart: Date.now(), firstEventAt: null, outputChars: 0, lastReadAt: Date.now() };
			const token = new vscode.CancellationTokenSource().token;
			const usage = await consumeStream(stream, state, token);
			assert.deepStrictEqual(usage, { prompt_tokens: 3, completion_tokens: 100, total_tokens: 103 });
			assert.strictEqual(state.outputChars, 3);
		});
	});

	suite("testSingleModel（mock fetch）", () => {
		/** mock 全局 fetch：支持 signal abort，abort 时以 AbortError reject（与真实 fetch 一致） */
		function mockFetchOnce(response: Response) {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				return new Promise<Response>((resolve, reject) => {
					const signal = init?.signal as AbortSignal | undefined;
					if (signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
					resolve(response);
				});
			}) as typeof fetch;
			return () => {
				globalThis.fetch = originalFetch;
			};
		}

		test("成功：mock fetch 返回标准 OpenAI SSE 流", async () => {
			const stream = sseStream([
				{ delta: { content: "Hello" } },
				{ delta: { content: " world" } },
				{ usage: { prompt_tokens: 5, completion_tokens: 1000, total_tokens: 1005 } },
			]);
			const response = new Response(stream, { status: 200, statusText: "OK" });
			const restore = mockFetchOnce(response);
			try {
				const model: HFModelItem = { id: "m1", owned_by: "libiaorobot" };
				const token = new vscode.CancellationTokenSource().token;
				const result: ModelTestResult = await testSingleModel(model, "sk-test", "openai", "https://gw.example.com/v1", token);
				assert.strictEqual(result.ok, true);
				assert.strictEqual(result.outputTokens, 1000);
				assert.ok((result.tps ?? 0) > 0);
				assert.ok((result.ttftMs ?? -1) >= 0);
			} finally {
				restore();
			}
		});

		test("成功：OpenAI Responses 流", async () => {
			const stream = sseStream([
				{ type: "response.output_text.delta", delta: "hi" },
				{ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 900 } } },
			]);
			const response = new Response(stream, { status: 200, statusText: "OK" });
			const restore = mockFetchOnce(response);
			try {
				const model: HFModelItem = { id: "m2", owned_by: "libiaorobot" };
				const token = new vscode.CancellationTokenSource().token;
				const result = await testSingleModel(model, "sk-test", "openai-responses", "https://gw.example.com/v1", token);
				assert.strictEqual(result.ok, true);
				assert.strictEqual(result.outputTokens, 900);
			} finally {
				restore();
			}
		});

		test("失败：HTTP 500 返回错误", async () => {
			const response = new Response("boom", { status: 500, statusText: "Internal Server Error" });
			const restore = mockFetchOnce(response);
			try {
				const model: HFModelItem = { id: "m3", owned_by: "libiaorobot" };
				const token = new vscode.CancellationTokenSource().token;
				const result = await testSingleModel(model, "sk-test", "openai", "https://gw.example.com/v1", token);
				assert.strictEqual(result.ok, false);
				assert.match(result.error || "", /\[500\]/);
			} finally {
				restore();
			}
		});

		test("失败：无 body 流", async () => {
			const response = new Response(null, { status: 200 });
			const restore = mockFetchOnce(response);
			try {
				const model: HFModelItem = { id: "m4", owned_by: "libiaorobot" };
				const token = new vscode.CancellationTokenSource().token;
				const result = await testSingleModel(model, "sk-test", "openai", "https://gw.example.com/v1", token);
				assert.strictEqual(result.ok, false);
			} finally {
				restore();
			}
		});

		test("取消：token 取消后返回取消错误", async () => {
			const cts = new vscode.CancellationTokenSource();
			const model: HFModelItem = { id: "m5", owned_by: "libiaorobot" };
			const restore = mockFetchOnce(
				new Response(sseStream([{ delta: { content: "hello" } }]), { status: 200, statusText: "OK" })
			);
			try {
				// 先取消，再发起请求
				cts.cancel();
				const result = await testSingleModel(model, "sk-test", "openai", "https://gw.example.com/v1", cts.token);
				assert.strictEqual(result.ok, false);
				assert.match(result.error || "", /取消|超时/);
			} finally {
				restore();
			}
		});
	});
});
