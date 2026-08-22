import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

// 回归测试：工具调用参数缓冲「内联参数污染」事故（2026-08-22，glm-5.2）
//
// 根因回顾：Anthropic 官方协议 content_block_start 的 tool_use 恒带 `input: {}` 占位，
// 真实参数靠后续 input_json_delta 逐块送达。旧实现把 start 内联的 `input`
// 直接 JSON.stringify 塞进 args 缓冲区 → args = `{}{"cmd":...}` → JSON.parse 永远失败
// → 冲刷时静默丢弃 → 宿主只收到 thinking、判 Unknown、报「Sorry, no response was returned.」。
//
// 方案 B 契约（本测试守护）：
//   1. args 只装流式 delta 拼接结果，发射第一优先；
//   2. start/added 内联参数进 inlineArgs 独立槽，绝不拼进 args；
//   3. inlineArgs 仅在「整条流没来过任何 delta」时作为兜底；
//   4. 非流式网关（start 直接给完整参数）必须照常工作。
suite("tool call buffer: 内联参数与流式参数分槽（方案 B）", () => {
	function sseStream(dataLines: string[]): ReadableStream<Uint8Array> {
		const payload = dataLines.map((d) => `data: ${d}\n\n`).join("");
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload));
				controller.close();
			},
		});
	}

	function anthropicSse(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
		return sseStream(chunks.map((c) => JSON.stringify(c)));
	}

	function collectToolCalls(parts: vscode.LanguageModelResponsePart2[]): vscode.LanguageModelToolCallPart[] {
		return parts.filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
	}

	function collectText(parts: vscode.LanguageModelResponsePart2[]): string {
		return parts
			.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
			.map((p) => p.value)
			.join("");
	}

	function recordingProgress(): { progress: vscode.Progress<vscode.LanguageModelResponsePart2>; parts: vscode.LanguageModelResponsePart2[] } {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		return { progress: { report: (p) => parts.push(p) }, parts };
	}

	suite("anthropic 链路", () => {
		// 复刻 2026-08-22 事故流：start 带 input:{} 占位 + 14 个 input_json_delta
		test("start 带 input:{} 占位 + 流式 delta → 正确拼接参数并发射（事故复现场景）", async () => {
			const api = new AnthropicApi("test-model", true);
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				anthropicSse([
					{ type: "message_start", message: { id: "msg_1", model: "glm-5.2", usage: { input_tokens: 100, output_tokens: 0 } } },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "tool_use", id: "toolu_1", name: "memory", input: {} },
					},
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "view",' } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "path": "/memories/repo/x.md"}' } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } },
					{ type: "message_stop" },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1, `应发射 1 个工具调用，实际 ${calls.length}（args 被 input:{} 污染会解析失败归零）`);
			assert.strictEqual(calls[0].callId, "toolu_1");
			assert.strictEqual(calls[0].name, "memory");
			assert.deepStrictEqual(calls[0].input, { command: "view", path: "/memories/repo/x.md" });
		});

		test("两个并行工具调用（事故同构：memory + memory）都能发射", async () => {
			const api = new AnthropicApi("test-model", true);
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				anthropicSse([
					{ type: "message_start", message: { id: "msg_1", model: "glm-5.2", usage: { input_tokens: 10, output_tokens: 0 } } },
					{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "memory", input: {} } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": "view"}' } },
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "read_file", input: {} } },
					{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"filePath": "a.ts",' } },
					{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' "startLine": 1, "endLine": 9}' } },
					{ type: "content_block_stop", index: 2 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
					{ type: "message_stop" },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 2);
			assert.deepStrictEqual(calls[0].input, { command: "view" });
			assert.deepStrictEqual(calls[1].input, { filePath: "a.ts", startLine: 1, endLine: 9 });
		});

		test("非流式网关：start 直接给完整参数、无 delta → inlineArgs 兜底发射", async () => {
			const api = new AnthropicApi("test-model", true);
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				anthropicSse([
					{ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_inline", name: "get_weather", input: { city: "北京" } },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
					{ type: "message_stop" },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1, "非流式内联参数必须在冲刷阶段兜底发射");
			assert.deepStrictEqual(calls[0].input, { city: "北京" });
		});

		test("无参工具：input:{} 且零 delta → 以 {} 发射（参数规范化）", async () => {
			const api = new AnthropicApi("test-model", true);
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				anthropicSse([
					{ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_np", name: "get_time", input: {} } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
					{ type: "message_stop" },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].input, {});
		});

		test("思考块 + 工具调用混排：工具发射且无正文泄漏", async () => {
			const api = new AnthropicApi("test-model", true);
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				anthropicSse([
					{ type: "message_start", message: { id: "msg_1", model: "glm-5.2", usage: { input_tokens: 10, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我看看……" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_t", name: "memory", input: {} } },
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": "view"}' } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
					{ type: "message_stop" },
				]),
				progress,
				token
			);
			// 宿主判定逻辑：text 或工具调用至少有一项 → Success，否则 Unknown（"no response"）
			assert.strictEqual(collectToolCalls(parts).length, 1, "工具调用必须发射，否则宿主判 Unknown");
			assert.strictEqual(collectText(parts), "", "该场景模型未输出正文，不应有文本泄漏");
		});
	});

	suite("responses 链路（同型雷防御）", () => {
		function responsesSse(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
			return sseStream([...events.map((e) => JSON.stringify(e)), "[DONE]"]);
		}

		test("added 事件内联 arguments 不与后续 delta 混拼（同型雷：added 预填即发射）", async () => {
			const api = new OpenaiResponsesApi("test-model");
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				responsesSse([
					{ type: "response.created", response: { id: "resp_1" } },
					// 网关若在 added 预填参数（如 "{}"），旧实现会立刻发射空参数工具并标记完成，
					// 后续真实参数 delta 全丢。修复后进 inlineArgs 槽、不触发流中发射。
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "memory", arguments: "{}" },
					},
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command": "view"}' },
					{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"command": "view"}' },
					{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "memory", arguments: '{"command": "view"}' } },
					{ type: "response.completed", response: { id: "resp_1" } },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1, `应发射 1 个工具调用，实际 ${calls.length}（added 预填会提前发射空参数版本）`);
			assert.deepStrictEqual(calls[0].input, { command: "view" });
		});

		test("非流式网关：added 带完整参数、无 delta → done 阶段照常发射", async () => {
			const api = new OpenaiResponsesApi("test-model");
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				responsesSse([
					{ type: "response.created", response: { id: "resp_2" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "get_weather", arguments: '{"city": "上海"}' },
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "get_weather", arguments: '{"city": "上海"}' },
					},
					{ type: "response.completed", response: { id: "resp_2" } },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1, "非流式内联参数必须在 output_item.done 冲刷时兜底发射");
			assert.deepStrictEqual(calls[0].input, { city: "上海" });
		});

		test("done 事件回空串不抹掉已拼好的参数", async () => {
			const api = new OpenaiResponsesApi("test-model");
			const { progress, parts } = recordingProgress();
			const token = new vscode.CancellationTokenSource().token;
			await api.processStreamingResponse(
				responsesSse([
					{ type: "response.created", response: { id: "resp_3" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "memory", arguments: "" },
					},
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command": "view"}' },
					// 异常网关：done 携带空 arguments——不应清空 delta 拼好的参数
					{ type: "response.function_call_arguments.done", output_index: 0, arguments: "" },
					{ type: "response.completed", response: { id: "resp_3" } },
				]),
				progress,
				token
			);
			const calls = collectToolCalls(parts);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0].input, { command: "view" });
		});
	});
});
