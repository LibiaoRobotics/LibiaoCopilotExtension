import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

// 回归测试（2026-08-23 qwen3.8-max 事故）：
// 网关/模型会自发调用服务端工具（file_search_call 等），旧解析器静默丢弃，
// 模型拿它顶替回合产出 → 空响应或正文中途截断。
// 修复：转成同名 function call + 每请求一条可见提示，客户端把「不可用」
// 错误回传模型，促其下轮改用真实工具（自愈闭环）。
suite("openaiResponsesApi server-side tool conversion", () => {
	function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
		const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
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

	function collectToolCalls(parts: vscode.LanguageModelResponsePart2[]): vscode.LanguageModelToolCallPart[] {
		return parts.filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
	}

	function recordingProgress(): { progress: vscode.Progress<vscode.LanguageModelResponsePart2>; parts: vscode.LanguageModelResponsePart2[] } {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		return { progress: { report: (p) => parts.push(p) }, parts };
	}

	async function run(events: Record<string, unknown>[]) {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(sseStream(events), progress, token);
		return parts;
	}

	test("file_search_call 转成同名 function call，queries 进参数", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_fs1" } },
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { id: "msg_fs1", queries: ["**/markdownRenderer.ts"], status: "in_progress", type: "file_search_call", results: null },
			},
			{ type: "response.file_search_call.in_progress", item_id: "msg_fs1", output_index: 1 },
			{ type: "response.file_search_call.searching", item_id: "msg_fs1", output_index: 1 },
			{ type: "response.file_search_call.completed", item_id: "msg_fs1", output_index: 1 },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { id: "msg_fs1", queries: ["**/markdownRenderer.ts"], status: "completed", type: "file_search_call", results: [] },
			},
			{ type: "response.completed", response: { id: "resp_fs1" } },
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1, "应发射恰好一个工具调用");
		assert.strictEqual(calls[0].name, "file_search_call");
		assert.deepStrictEqual(calls[0].input, { queries: ["**/markdownRenderer.ts"] });
	});

	test("转换时向 UI 发可见提示", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_fs2" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "msg_fs2", queries: ["x"], status: "in_progress", type: "file_search_call", results: null },
			},
			{ type: "response.completed", response: { id: "resp_fs2" } },
		]);

		const text = collectText(parts);
		assert.ok(text.includes("file_search_call"), `提示应包含工具名, got: ${text}`);
		assert.ok(text.includes("服务端工具"), `提示应说明是服务端工具, got: ${text}`);
	});

	test("同一 response 多个服务端工具：提示仅一条、工具调用按 item 各一个", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_fs3" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "msg_a", queries: ["a"], status: "in_progress", type: "file_search_call", results: null },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { id: "msg_a", queries: ["a"], status: "completed", type: "file_search_call", results: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { id: "msg_b", queries: ["b"], status: "in_progress", type: "web_search_call", results: null },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { id: "msg_b", queries: ["b"], status: "completed", type: "web_search_call", results: [] },
			},
			{ type: "response.completed", response: { id: "resp_fs3" } },
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 2, "两个不同 item 各发射一次");
		assert.strictEqual(calls[0].name, "file_search_call");
		assert.strictEqual(calls[1].name, "web_search_call");

		const text = collectText(parts);
		const noticeCount = text.split("服务端工具").length - 1;
		assert.strictEqual(noticeCount, 1, `每请求提示至多一条, got ${noticeCount} 条`);
	});

	test("added+done 同 index 不双发", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_fs4" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "msg_c", queries: ["c"], status: "in_progress", type: "file_search_call", results: null },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { id: "msg_c", queries: ["c"], status: "completed", type: "file_search_call", results: [] },
			},
			{ type: "response.completed", response: { id: "resp_fs4" } },
		]);

		assert.strictEqual(collectToolCalls(parts).length, 1, "done 事件不应重复发射");
	});

	test("正常 function_call 不受影响（无提示文字）", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_fc1" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "msg_f", arguments: "", call_id: "call_1", name: "grep_search", type: "function_call", status: "in_progress" },
			},
			{ type: "response.function_call_arguments.delta", delta: "{\"query\": \"x\"}", item_id: "msg_f", output_index: 0 },
			{ type: "response.function_call_arguments.done", arguments: "{\"query\": \"x\"}", item_id: "msg_f", output_index: 0 },
			{ type: "response.completed", response: { id: "resp_fc1" } },
		]);

		const calls = collectToolCalls(parts);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].name, "grep_search");
		assert.strictEqual(collectText(parts), "", "正常工具调用不应附带提示文字");
	});
});
