import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";

/**
 * 回归测试套件：OpenAI chat/completions 模式流式响应解析（OpenaiApi.processStreamingResponse）
 * 覆盖场景：
 * 1. 纯文本流（delta.content 累加发射）
 * 2. 结构化思考字段（reasoning_content / reasoning / thinking）
 * 3. 文本流内嵌 <think> 标签的自动剥离与分流
 * 4. 流式 Tool Calls 分片按 index 拼接并于 [DONE] 冲刷发射
 * 5. 多工具并行调用（多 index 混排）
 * 6. usage 统计提取 (stream_options.include_usage)
 */
suite("OpenaiApi chat/completions streaming parser", () => {
	function sseStream(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
		const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload));
				controller.close();
			},
		});
	}

	function collectText(parts: vscode.LanguageModelResponsePart2[]): string {
		return parts
			.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
			.map((p) => p.value)
			.join("");
	}

	function collectThinking(parts: vscode.LanguageModelResponsePart2[]): string {
		return parts
			.filter((p): p is vscode.LanguageModelThinkingPart => p instanceof vscode.LanguageModelThinkingPart)
			.map((p) => (Array.isArray(p.value) ? p.value.join("") : p.value))
			.join("");
	}

	function collectToolCalls(parts: vscode.LanguageModelResponsePart2[]): vscode.LanguageModelToolCallPart[] {
		return parts.filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
	}

	function recordingProgress(): { progress: vscode.Progress<vscode.LanguageModelResponsePart2>; parts: vscode.LanguageModelResponsePart2[] } {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		return { progress: { report: (p) => parts.push(p) }, parts };
	}

	async function run(chunks: Record<string, unknown>[], api = new OpenaiApi("test-model")) {
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(sseStream(chunks), progress, token);
		return { parts, api };
	}

	test("纯文本流式逐块发射", async () => {
		const { parts } = await run([
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: " " } }] },
			{ choices: [{ delta: { content: "World!" } }] },
		]);

		assert.strictEqual(collectText(parts), "Hello World!");
		assert.strictEqual(collectThinking(parts), "");
		assert.strictEqual(collectToolCalls(parts).length, 0);
	});

	test("原生 reasoning_content 字段：正确提取为 thinking part", async () => {
		const { parts } = await run([
			{ choices: [{ delta: { reasoning_content: "让我想想..." } }] },
			{ choices: [{ delta: { reasoning_content: "找到了。" } }] },
			{ choices: [{ delta: { content: "答案是 42。" } }] },
		]);

		assert.strictEqual(collectThinking(parts), "让我想想...找到了。");
		assert.strictEqual(collectText(parts), "答案是 42。");
	});

	test("文本内嵌 <think> 标签：自动分离思考与正文", async () => {
		const { parts } = await run([
			{ choices: [{ delta: { content: "<think>这是" } }] },
			{ choices: [{ delta: { content: "思考过程</think>" } }] },
			{ choices: [{ delta: { content: "这是真正正文。" } }] },
		]);

		assert.strictEqual(collectThinking(parts), "这是思考过程");
		assert.strictEqual(collectText(parts), "这是真正正文。");
	});

	test("流式 Tool Call 拼接：分片 arguments 正确累加并在 [DONE] 发射", async () => {
		const { parts } = await run([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc123",
									type: "function",
									function: { name: "grep_search", arguments: "" },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: '{"query":' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: ' "export class"}' },
								},
							],
						},
					},
				],
			},
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].callId, "call_abc123");
		assert.strictEqual(calls[0].name, "grep_search");
		assert.deepStrictEqual(calls[0].input, { query: "export class" });
	});

	test("多工具并发调用：不同 index 的 arguments 分别累加并独立发射", async () => {
		const { parts } = await run([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"filePath": "a.ts"}' } },
								{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"filePath": "b.ts"}' } },
							],
						},
					},
				],
			},
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].callId, "c1");
		assert.deepStrictEqual(calls[0].input, { filePath: "a.ts" });
		assert.strictEqual(calls[1].callId, "c2");
		assert.deepStrictEqual(calls[1].input, { filePath: "b.ts" });
	});

	test("usage 捕获：最后一个带 usage 的 chunk 能够被正确记录", async () => {
		const { api } = await run([
			{ choices: [{ delta: { content: "Done" } }] },
			{
				choices: [],
				usage: {
					prompt_tokens: 15,
					completion_tokens: 45,
					total_tokens: 60,
				},
			},
		]);

		const usage = api.getUsage();
		assert.ok(usage);
		assert.strictEqual(usage.prompt_tokens, 15);
		assert.strictEqual(usage.completion_tokens, 45);
		assert.strictEqual(usage.total_tokens, 60);
	});
});
