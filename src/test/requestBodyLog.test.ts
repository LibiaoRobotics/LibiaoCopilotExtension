import * as assert from "assert";
import { summarizeRequestBodyForLog } from "../provider";

// 回归：debug 日志里整份会话历史会被逐请求重复落盘，实测单请求 0.4~1.0MB、
// 单日 900MB+，其中历史载荷（request.body 的 input/messages/contents）占 46%，
// 且随会话线性增长。改为只记骨架：条数 / 角色分布 / 字符量，其余字段原样保留。
suite("provider request body log summarization", () => {
	test("Responses input 数组被替换为骨架摘要", () => {
		const body = {
			model: "deepseek-v4-flash-vision-exp",
			stream: true,
			reasoning: { effort: "xhigh", summary: null },
			input: [
				{ role: "user", content: [{ type: "input_text", text: "你好" }] },
				{ type: "function_call", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
				{ type: "function_call_output", call_id: "c1", output: "内容" },
			],
		};

		const result = summarizeRequestBodyForLog(body) as Record<string, unknown>;
		const input = result.input as Record<string, unknown>;

		assert.strictEqual(input.count, 3, "应记录历史条数");
		assert.deepStrictEqual(input.roles, { user: 1, function_call: 1, function_call_output: 1 });
		assert.ok(typeof input.chars === "number" && input.chars > 0, "应记录字符总量");
		assert.strictEqual(input.omittedHint, "history omitted", "必须标明历史已被省略");
		assert.strictEqual("content" in input, false, "原始历史内容不得残留");
	});

	test("OpenAI/Anthropic/Ollama 的 messages 字段同样被摘要", () => {
		const body = {
			model: "m",
			messages: [
				{ role: "system", content: "你是助手" },
				{ role: "user", content: "问题" },
				{ role: "assistant", content: "回答" },
			],
		};

		const result = summarizeRequestBodyForLog(body) as Record<string, unknown>;
		const messages = result.messages as Record<string, unknown>;

		assert.strictEqual(messages.count, 3);
		assert.deepStrictEqual(messages.roles, { system: 1, user: 1, assistant: 1 });
	});

	test("Gemini 的 contents 字段同样被摘要", () => {
		const body = {
			contents: [
				{ role: "user", parts: [{ text: "问题" }] },
				{ role: "model", parts: [{ text: "回答" }] },
			],
			systemInstruction: { role: "user", parts: [{ text: "系统提示" }] },
		};

		const result = summarizeRequestBodyForLog(body) as Record<string, unknown>;

		assert.strictEqual((result.contents as Record<string, unknown>).count, 2);
		// systemInstruction 是对象不是数组：不属于历史载荷，排障需要，保持原样
		assert.deepStrictEqual(result.systemInstruction, body.systemInstruction);
	});

	test("调参字段与工具定义原样保留", () => {
		const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
		const body = {
			model: "m",
			stream: true,
			temperature: 0.3,
			reasoning: { effort: "xhigh" },
			reasoning_effort: "xhigh",
			tools,
			messages: [{ role: "user", content: "hi" }],
		};

		const result = summarizeRequestBodyForLog(body) as Record<string, unknown>;

		assert.strictEqual(result.model, "m");
		assert.strictEqual(result.stream, true);
		assert.strictEqual(result.temperature, 0.3);
		assert.deepStrictEqual(result.reasoning, { effort: "xhigh" });
		assert.strictEqual(result.reasoning_effort, "xhigh");
		assert.deepStrictEqual(result.tools, tools, "工具定义必须完整保留");
	});

	test("非对象入参与不含历史字段的请求体不受影响", () => {
		assert.strictEqual(summarizeRequestBodyForLog(null), null);
		assert.strictEqual(summarizeRequestBodyForLog("text"), "text");
		assert.deepStrictEqual(summarizeRequestBodyForLog([1, 2]), [1, 2]);

		const noHistory = { model: "m", stream: true };
		assert.deepStrictEqual(summarizeRequestBodyForLog(noHistory), noHistory);
	});
});
