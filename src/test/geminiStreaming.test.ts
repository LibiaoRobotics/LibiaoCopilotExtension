import * as assert from "assert";
import * as vscode from "vscode";
import { GeminiApi } from "../gemini/geminiApi";

/**
 * 回归测试套件：Gemini API 原生流式响应解析（GeminiApi.processStreamingResponse）
 * 覆盖场景：
 * 1. 文本流分块（text delta 增量发射）
 * 2. 思考流（Gemini 2.0/3.7 thought: true 与 thought 字符串提取）
 * 3. 工具调用（functionCall 结构解析与去重发射）
 * 4. 思考与工具混排场景
 * 5. usageMetadata 统计提取（包含 thoughtsTokenCount 计入 completion_tokens）
 * 6. 异常 chunk 容错（非法 JSON、空数据、[DONE] 标记）
 */
suite("GeminiApi streaming response parser", () => {
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

	async function run(chunks: Record<string, unknown>[], api = new GeminiApi("gemini-3.7-flash")) {
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(sseStream(chunks), progress, token);
		return { parts, api };
	}

	test("纯文本分块流式发射", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [{ text: "Hello " }],
							role: "model",
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ text: "world!" }],
							role: "model",
						},
					},
				],
			},
		]);

		assert.strictEqual(collectText(parts), "Hello world!");
		assert.strictEqual(collectThinking(parts), "");
		assert.strictEqual(collectToolCalls(parts).length, 0);
	});

	test("Gemini 3.7 思考流：thought: true 提取为 thinking part，正文正常发射", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [
								{ text: "正在分析问题...", thought: true },
								{ text: "找到了解法。", thought: true },
							],
							role: "model",
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ text: "这是最终答案。" }],
							role: "model",
						},
					},
				],
			},
		]);

		assert.strictEqual(collectThinking(parts), "正在分析问题...找到了解法。");
		assert.strictEqual(collectText(parts), "这是最终答案。");
	});

	test("Gemini 2.0 Flash 思考流：thought 字符串字段提取", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [{ thought: "思考第一步。" }],
							role: "model",
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ thought: "思考第二步。" }],
							role: "model",
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ text: "回答完毕。" }],
							role: "model",
						},
					},
				],
			},
		]);

		assert.strictEqual(collectThinking(parts), "思考第一步。思考第二步。");
		assert.strictEqual(collectText(parts), "回答完毕。");
	});

	test("工具调用：functionCall 结构解析为 LanguageModelToolCallPart", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "read_file",
										args: { filePath: "src/index.ts", startLine: 1, endLine: 50 },
									},
								},
							],
							role: "model",
						},
					},
				],
			},
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].name, "read_file");
		assert.deepStrictEqual(calls[0].input, { filePath: "src/index.ts", startLine: 1, endLine: 50 });
	});

	test("工具调用去重：相同 functionCall 在不同 chunk 中出现时不重复发射", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "list_dir",
										args: { path: "src" },
									},
								},
							],
						},
					},
				],
			},
			// 网关在后续 chunk 再次包含相同的 functionCall
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "list_dir",
										args: { path: "src" },
									},
								},
							],
						},
					},
				],
			},
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1, "相同工具调用不应重复发射");
	});

	test("思考与工具调用混排：思考进入折叠区，工具调用正常触发", async () => {
		const { parts } = await run([
			{
				candidates: [
					{
						content: {
							parts: [{ text: "我需要先查看目录结构。", thought: true }],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "list_dir",
										args: { path: "src" },
									},
								},
							],
						},
					},
				],
			},
		]);

		assert.strictEqual(collectThinking(parts), "我需要先查看目录结构。");
		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].name, "list_dir");
	});

	test("usageMetadata 正确提取并累计思考 token 到 completion_tokens", async () => {
		const { api } = await run([
			{
				candidates: [
					{
						content: {
							parts: [{ text: "ok" }],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 100,
					candidatesTokenCount: 50,
					thoughtsTokenCount: 80,
					totalTokenCount: 230,
					cachedContentTokenCount: 20,
				},
			},
		]);

		const usage = api.getUsage();
		assert.ok(usage);
		assert.strictEqual(usage.prompt_tokens, 100);
		// completion_tokens 必须包含思考 token: 50 + 80 = 130
		assert.strictEqual(usage.completion_tokens, 130);
		assert.strictEqual(usage.total_tokens, 230);
		assert.deepStrictEqual(usage.prompt_tokens_details, { cached_tokens: 20 });
		assert.deepStrictEqual(usage.completion_tokens_details, { reasoning_tokens: 80 });
	});

	test("容错性：遇到畸变 chunk / 空数据 / [DONE] 时平稳跳过不崩溃", async () => {
		const rawPayload =
			"data: \n\n" +
			"data: { invalid json \n\n" +
			"data: " +
			JSON.stringify({
				candidates: [{ content: { parts: [{ text: "正常内容" }] } }],
			}) +
			"\n\n" +
			"data: [DONE]\n\n";

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(rawPayload));
				controller.close();
			},
		});

		const api = new GeminiApi("gemini-3.7-flash");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(stream, progress, token);

		assert.strictEqual(collectText(parts), "正常内容");
	});
});
