import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import type { AnthropicRequestBody } from "../anthropic/anthropicTypes";
import { GeminiApi } from "../gemini/geminiApi";
import { convertToolsToOpenAI, convertToolsToOpenAIResponses } from "../utils";

/**
 * 回归测试套件：多协议消息格式转换与请求体组装
 * 覆盖：
 * 1. GeminiApi.convertMessages (多模态图片、连续 tool results 聚合为单一 user 轮次、JSON 解析)
 * 2. AnthropicApi.convertMessages & prepareRequestBody (system 提取、cache_control 预算超限裁剪)
 * 3. convertToolsToOpenAI / convertToolsToOpenAIResponses (工具 Schema 转换、toolMode.Required 校验)
 */
suite("Multi-protocol message conversion & request builder", () => {
	const system = (text: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.System,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});

	const user = (text: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});

	const userWithImage = (text: string, mimeType: string, data: Uint8Array): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text), new vscode.LanguageModelDataPart(data, mimeType)],
	});

	const assistantWithToolCalls = (
		toolCalls: Array<{ callId: string; name: string; input: Record<string, unknown> }>,
		text?: string
	): vscode.LanguageModelChatRequestMessage => {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		if (text) {
			parts.push(new vscode.LanguageModelTextPart(text));
		}
		for (const tc of toolCalls) {
			parts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
		}
		return {
			role: vscode.LanguageModelChatMessageRole.Assistant,
			name: undefined,
			content: parts,
		};
	};

	const userWithToolResult = (callId: string, text: string): vscode.LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)])],
	});

	suite("GeminiApi message conversion", () => {
		test("基础多轮对话：User 转 user，Assistant 转 model", () => {
			const api = new GeminiApi("gemini-3.7-flash");
			const messages = [user("你好"), { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [new vscode.LanguageModelTextPart("你好！有什么我可以帮你的？")] }];
			const converted = api.convertMessages(messages, { includeReasoningInRequest: false });

			assert.strictEqual(converted.length, 2);
			assert.strictEqual(converted[0].role, "user");
			assert.deepStrictEqual(converted[0].parts, [{ text: "你好" }]);
			assert.strictEqual(converted[1].role, "model");
			assert.deepStrictEqual(converted[1].parts, [{ text: "你好！有什么我可以帮你的？" }]);
		});

		test("多模态图片：转换为 inlineData 格式", () => {
			const api = new GeminiApi("gemini-3.7-flash");
			const rawBytes = new Uint8Array([137, 80, 78, 71]); // PNG 魔数
			const expectedBase64 = Buffer.from(rawBytes).toString("base64");

			const messages = [userWithImage("看看这张图", "image/png", rawBytes)];
			const converted = api.convertMessages(messages, { includeReasoningInRequest: false });

			assert.strictEqual(converted.length, 1);
			assert.strictEqual(converted[0].role, "user");
			assert.strictEqual(converted[0].parts.length, 2);
			assert.deepStrictEqual(converted[0].parts[0], { text: "看看这张图" });
			assert.deepStrictEqual(converted[0].parts[1], {
				inlineData: { mimeType: "image/png", data: expectedBase64 },
			});
		});

		test("连续多个工具调用结果：合并为同一个 user 轮次的多个 functionResponse", () => {
			const api = new GeminiApi("gemini-3.7-flash");
			const messages = [
				user("请帮我查天气和时间"),
				assistantWithToolCalls([
					{ callId: "c1", name: "get_weather", input: { city: "杭州" } },
					{ callId: "c2", name: "get_time", input: {} },
				]),
				userWithToolResult("c1", JSON.stringify({ temp: 25, condition: "Sunny" })),
				userWithToolResult("c2", "18:30"),
			];

			const converted = api.convertMessages(messages, { includeReasoningInRequest: false });

			// 应转换为 3 轮：user -> model (带2个 functionCall) -> user (合并2个 functionResponse)
			assert.strictEqual(converted.length, 3);
			assert.strictEqual(converted[0].role, "user");
			assert.strictEqual(converted[1].role, "model");
			assert.strictEqual(converted[1].parts.length, 2);
			assert.deepStrictEqual((converted[1].parts[0] as Record<string, unknown>).functionCall, {
				name: "get_weather",
				args: { city: "杭州" },
			});

			assert.strictEqual(converted[2].role, "user");
			assert.strictEqual(converted[2].parts.length, 2, "2个工具结果必须合并进同一个 user 轮次");
			// JSON 字符串应自动解析为结构化响应对象
			assert.deepStrictEqual((converted[2].parts[0] as Record<string, unknown>).functionResponse, {
				name: "get_weather",
				response: { temp: 25, condition: "Sunny" },
			});
			// 普通非 JSON 字符串包装为 { output: text }
			assert.deepStrictEqual((converted[2].parts[1] as Record<string, unknown>).functionResponse, {
				name: "get_time",
				response: { output: "18:30" },
			});
		});

		test("ThoughtSignature 跨轮次复用：缓存中的 thoughtSignature 自动附着在 model 的 functionCall 上", () => {
			const metaMap = new Map<string, import("../gemini/geminiApi").GeminiToolCallMeta>();
			metaMap.set("call_test_123", {
				name: "search_code",
				thoughtSignature: "sig_cached_token_xyz",
				thought: "分析中...",
				createdAt: Date.now(),
			});

			const api = new GeminiApi("gemini-3-pro-preview", metaMap);
			const messages = [
				user("请搜索代码"),
				assistantWithToolCalls([{ callId: "call_test_123", name: "search_code", input: { query: "export" } }]),
				userWithToolResult("call_test_123", "found 1 result"),
			];

			const converted = api.convertMessages(messages, { includeReasoningInRequest: false });
			assert.strictEqual(converted.length, 3);
			const modelTurn = converted[1];
			assert.strictEqual(modelTurn.role, "model");
			const part = modelTurn.parts[0] as Record<string, unknown>;
			assert.strictEqual(part.thoughtSignature, "sig_cached_token_xyz", "跨轮次必须携带 thoughtSignature");
			assert.strictEqual(part.thought, "分析中...", "跨轮次必须携带 thought 文本");
		});
	});

	suite("AnthropicApi message conversion & cache control", () => {
		test("System 提示词提取：多个 system 消息合并", () => {
			const api = new AnthropicApi("claude-3-7-sonnet", false);
			const messages = [system("You are an expert coder."), system("Always respond in Chinese."), user("你好")];
			api.convertMessages(messages, { includeReasoningInRequest: false });

			const body = api.prepareRequestBody({ model: "claude-3-7-sonnet", max_tokens: 4096, messages: [] }, undefined);
			assert.strictEqual(body.system, "You are an expert coder.\n\nAlways respond in Chinese.");
		});

		test("缓存控制预算裁剪：超过 4 个 cache_control 时优先剥离最早的 message 级别断点", () => {
			// 开启 cache control
			const api = new AnthropicApi("claude-3-7-sonnet", true);
			const makeCcPart = () =>
				new vscode.LanguageModelDataPart(
					new TextEncoder().encode(JSON.stringify({ type: "ephemeral" })),
					"cache_control"
				);

			const messages = [
				system("System Prompt"),
				{
					role: vscode.LanguageModelChatMessageRole.User,
					name: undefined,
					content: [new vscode.LanguageModelTextPart("Msg 1"), makeCcPart()],
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					name: undefined,
					content: [new vscode.LanguageModelTextPart("Reply 1"), makeCcPart()],
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					name: undefined,
					content: [new vscode.LanguageModelTextPart("Msg 2"), makeCcPart()],
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					name: undefined,
					content: [new vscode.LanguageModelTextPart("Reply 2"), makeCcPart()],
				},
			];

			const converted = api.convertMessages(messages, { includeReasoningInRequest: false });
			const initialBody: AnthropicRequestBody = {
				model: "claude-3-7-sonnet",
				max_tokens: 4096,
				messages: converted,
			};

			const finalBody = api.prepareRequestBody(initialBody, undefined, {
				tools: [
					{
						name: "test_tool",
						description: "desc",
						inputSchema: { type: "object", properties: {} },
					},
				],
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions);

			// 统计最终保留的 cache_control 总数
			let ccCount = 0;
			if (Array.isArray(finalBody.system)) {
				for (const s of finalBody.system) {
					if (s.cache_control) {
						ccCount++;
					}
				}
			}
			if (finalBody.tools) {
				for (const t of finalBody.tools) {
					if (t.cache_control) {
						ccCount++;
					}
				}
			}
			for (const m of finalBody.messages) {
				if (Array.isArray(m.content)) {
					for (const b of m.content) {
						if ((b as { cache_control?: unknown }).cache_control) {
							ccCount++;
						}
					}
				}
			}

			assert.ok(ccCount <= 4, `总 cache_control 数量不能超过 Anthropic 官方上限 4，当前: ${ccCount}`);
		});
	});

	suite("Tool definition converters (OpenAI / OpenAI Responses)", () => {
		test("convertToolsToOpenAI: 正常转换函数定义", () => {
			const options = {
				tools: [
					{
						name: "grep_search",
						description: "Search workspace by regex",
						inputSchema: {
							type: "object",
							properties: {
								query: { type: "string", description: "Search query" },
							},
							required: ["query"],
						},
					},
				],
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

			const result = convertToolsToOpenAI(options);
			assert.strictEqual(result.tools?.length, 1);
			assert.strictEqual(result.tools?.[0].type, "function");
			assert.strictEqual(result.tools?.[0].function.name, "grep_search");
			assert.strictEqual(result.tools?.[0].function.description, "Search workspace by regex");
			assert.deepStrictEqual(result.tools?.[0].function.parameters, {
				type: "object",
				properties: { query: { type: "string", description: "Search query" } },
				required: ["query"],
			});
			assert.strictEqual(result.tool_choice, "auto");
		});

		test("convertToolsToOpenAI: toolMode 为 Required 时单工具强制指定", () => {
			const options = {
				tools: [
					{
						name: "single_tool",
						description: "Must be called",
						inputSchema: { type: "object" },
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

			const result = convertToolsToOpenAI(options);
			assert.deepStrictEqual(result.tool_choice, {
				type: "function",
				function: { name: "single_tool" },
			});
		});

		test("convertToolsToOpenAI: toolMode 为 Required 但有多个工具时抛错", () => {
			const options = {
				tools: [
					{ name: "tool1", inputSchema: { type: "object" } },
					{ name: "tool2", inputSchema: { type: "object" } },
				],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

			assert.throws(() => convertToolsToOpenAI(options), /ToolMode\.Required is not supported with more than one tool/);
		});

		test("convertToolsToOpenAIResponses: 扁平化结构输出", () => {
			const options = {
				tools: [
					{
						name: "read_file",
						description: "Read file content",
						inputSchema: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

			const result = convertToolsToOpenAIResponses(options);
			assert.strictEqual(result.tools?.length, 1);
			assert.strictEqual(result.tools?.[0].type, "function");
			assert.strictEqual(result.tools?.[0].name, "read_file");
			assert.strictEqual(result.tools?.[0].description, "Read file content");
			assert.ok(
				!("function" in (result.tools?.[0] as unknown as Record<string, unknown>)),
				"Responses 模式下不应有嵌套 function 包装"
			);
		});
	});
});
