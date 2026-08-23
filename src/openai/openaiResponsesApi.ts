import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";
import {
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	isReasoningEffortValue,
} from "../modelConfiguration";
import type { OpenAIToolCall } from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAIResponses,
	mapRole,
} from "../utils";

import { CommonApi } from "../commonApi";
import { logger } from "../logger";

export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system";
	content: ResponsesContentPart[];
	type?: "message";
	id?: string;
	status?: "completed" | "incomplete";
}

export interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text" | "summary_text";
	text?: string;
	image_url?: string;
	detail?: "auto";
}

export interface ResponsesFunctionCall {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
}

export interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
	id: string;
	status: "completed";
}

export interface ResponsesReasoning {
	type: "reasoning";
	summary: ResponsesContentPart[];
	id: string;
	status: "completed";
}

export type ResponsesInputItem =
	| ResponsesInputMessage
	| ResponsesFunctionCall
	| ResponsesFunctionCallOutput
	| ResponsesReasoning;

export class OpenaiResponsesApi extends CommonApi<ResponsesInputItem, Record<string, unknown>> {
	private _responseId: string | null = null;
	/**
	 * Fuse semantics (monotonic, never reset): once any non-empty output text
	 * delta has been seen, the output_text.done fallback is permanently
	 * disabled. This decouples the done-event dedup from WHERE the delta
	 * content ended up (plain text vs XML think blocks) — see 2026-08-15 fix.
	 */
	private _sawTextDelta = false;
	/** Same fuse for reasoning/thinking deltas vs their done events. */
	private _sawReasoningDelta = false;
	/** 本请求是否已发过服务端工具转换提示（每请求至多一次） */
	private _serverToolNotified = false;
	/** reasoning 通道累积文本（泄漏守卫的判别信号来源） */
	private _reasoningAccum = "";
	/** 泄漏守卫是否已评估（首个正文 chunk 时一次性评估） */
	private _leakGuardEvaluated = false;
	/** 泄漏守卫激活中：正文先缓冲，待孤儿 </think> 确认或超上限flush */
	private _leakGuardActive = false;
	private _leakGuardBuffer = "";

	constructor(modelId: string) {
		super(modelId);
	}

	get responseId(): string | null {
		return this._responseId;
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ResponsesInputItem[] {
		const out: ResponsesInputItem[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					let args = "{}";
					try {
						args = JSON.stringify(part.input ?? {});
					} catch {
						args = "{}";
					}
					toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
				} else if (part instanceof vscode.LanguageModelThinkingPart && modelConfig.includeReasoningInRequest) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// assistant message (optional)
			if (role === "assistant") {
				if (joinedText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: joinedText }],
						type: "message",
						id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				if (joinedThinking) {
					out.push({
						summary: [{ type: "summary_text", text: joinedThinking }],
						type: "reasoning",
						id: `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						id: `fc_${tc.id}`,
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
						status: "completed",
					});
				}
			}

			// tool outputs
			for (const tr of toolResults) {
				if (!tr.callId) {
					continue;
				}
				out.push({
					type: "function_call_output",
					call_id: tr.callId,
					output: tr.content || "",
					id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					status: "completed",
				});
			}

			// user message
			if (role === "user") {
				const contentArray: ResponsesContentPart[] = [];
				if (joinedText) {
					contentArray.push({ type: "input_text", text: joinedText });
				}
				for (const imagePart of imageParts) {
					const dataUrl = createDataUrl(imagePart);
					contentArray.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
				}
				if (contentArray.length > 0) {
					out.push({
						role: "user",
						content: contentArray,
						type: "message",
						status: "completed",
					});
				}
			}

			// system message (used to build `instructions` in request body)
			if (role === "system" && joinedText) {
				this._systemContent = this._systemContent
					? `${this._systemContent}\n\n${joinedText}`
					: joinedText;
			}
		}

		// the last user message may be incomplete
		if (out.length > 0) {
			const lastItem = out[out.length - 1];
			if (lastItem && typeof lastItem === "object" && "type" in lastItem) {
				const item = lastItem as unknown as Record<string, unknown>;
				if (item.type === "message" && item.role === "user") {
					item.status = "incomplete";
				}
			}
		}
		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		const isPlainObject = (v: unknown): v is Record<string, unknown> =>
			!!v && typeof v === "object" && !Array.isArray(v);

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.instructions = this._systemContent;
		}

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_output_tokens
		if (um?.max_completion_tokens !== undefined) {
			rb.max_output_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			rb.max_output_tokens = um.max_tokens;
		}

		// OpenAI reasoning configuration
		// 双写（嵌套 + 顶层）：不同网关对 Responses 端点支持不同。
		// - 嵌套 `reasoning.effort`：Responses 官方规范字段，new-api 对 deepseek 等认这个；
		// - 顶层 `reasoning_effort`：部分网关（实测 new-api 对 qwen3.8-max）只认顶层，
		//   嵌套会被忽略导致用户选择的 effort 不生效；
		// 两个字段都写，各网关各取所需（实测不冲突）。
		if (isReasoningEffortPickerEnabled(um)) {
			const allowedEfforts = um.reasoning_efforts?.filter(isReasoningEffortValue);
			const effort = getConfiguredReasoningEffort(options, um.reasoning_effort, allowedEfforts);
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort,
			};
			rb.reasoning_effort = effort;
		} else if (um?.reasoning_effort !== undefined) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: um.reasoning_effort,
			};
			// 非 picker 模型也双写（若模型配置了 reasoning_effort）
			if (isReasoningEffortValue(um.reasoning_effort)) {
				rb.reasoning_effort = um.reasoning_effort;
			}
		}

		// thinking (Volcengine provider)
		if (um?.thinking?.type !== undefined) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// stop
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAIResponses(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					// Deep-merge reasoning config so `extra.reasoning` doesn't clobber `reasoning.effort`.
					if (key === "reasoning" && isPlainObject(value) && isPlainObject(rb.reasoning)) {
						rb.reasoning = { ...(rb.reasoning as Record<string, unknown>), ...(value as Record<string, unknown>) };
						continue;
					}
					if (key === "tools" && Array.isArray(value) && Array.isArray(rb.tools)) {
						rb.tools = [...rb.tools, ...value];
					} else {
						rb[key] = value;
					}
				}
			}
		}

		return rb;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this._responseId = null;
		const modelId = this._modelId;
		logger.debug("responses.stream.start", { modelId });
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					logger.debug("responses.stream.chunk", { modelId, data });
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						continue;
					}

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						await this.processEvent(parsed, progress);
					} catch (e) {
						console.error("[OpenAI-Responses Provider] Failed to parse SSE chunk:", e, "data:", data);
						logger.error("responses.stream.chunk.error", {
							modelId,
							error: e instanceof Error ? e.message : String(e),
							data,
						});
					}
				}
			}
			logger.debug("responses.stream.done", { modelId, responseId: this._responseId ?? "" });
		} catch (e) {
			console.error("[OpenAI-Responses Provider] Streaming response error:", e);
			logger.error("responses.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
			// 泄漏守卫未决收尾：流结束仍无孤儿闭标签，缓冲按正文发射（不丢内容）
			if (this._leakGuardActive && this._leakGuardBuffer) {
				const flushed = this._leakGuardBuffer;
				this._leakGuardActive = false;
				this._leakGuardBuffer = "";
				this.processTextContent(flushed, progress);
			}
			// 冲刷 XML think 挂起缓冲（先于收尾：激活时挂起归入思考缓冲，随收尾同步冲刷）
			this.flushXmlThinkPending(progress);
			this.reportEndThinking(progress);
			// Report accumulated usage for the Context Window widget
			this.reportUsage(progress);
		}
	}

	private coerceText(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			if (typeof obj.text === "string") {
				return obj.text;
			}
			if (typeof obj.thinking === "string") {
				return obj.thinking;
			}
			if (typeof obj.reasoning === "string") {
				return obj.reasoning;
			}
			if (typeof obj.summary === "string") {
				return obj.summary;
			}
			if (typeof obj.value === "string") {
				return obj.value;
			}
		}
		return "";
	}

	private looksLikeReasoningConfigValue(value: string): boolean {
		const v = (value || "").trim().toLowerCase();
		return (
			v === "high" ||
			v === "medium" ||
			v === "low" ||
			v === "minimal" ||
			v === "auto" ||
			v === "none" ||
			v === "detailed" ||
			v === "concise"
		);
	}

	/** 泄漏守卫缓冲上限（字符）：超上限仍无孤儿闭标签判误报，flush 为正文 */
	private static readonly LEAK_GUARD_CAP = 2000;

	/** reasoning 以未完成代码跨度收尾（反引号奇数）= 思考被拦腰切断的信号 */
	private hasUnbalancedCodeSpan(text: string): boolean {
		let count = 0;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 96) {
				count++;
			}
		}
		return count % 2 === 1;
	}

	/**
	 * 思考跨通道泄漏守卫（2026-08-23，qwen3.8-max 第四慢性病）：
	 * 模型有时把思考后半续写到正文通道（无 <think> 开标签、以 </think> 自闭），
	 * processXmlThinkBlocks 认不出无开标签的块 → 思考尾巴 + 闭标签漏进正文。
	 * 判别信号（日志实证 5/5 命中、误报 4.8%）：reasoning 以失衡反引号收尾。
	 * 守卫模式：正文先缓冲；见孤儿 </think> → 缓冲转思考 part、丢标签；
	 * 超上限或见 <think> → 判误报，flush 为正文。代价：误报回合正文开头延迟。
	 */
	private runLeakGuard(text: string, progress: Progress<vscode.LanguageModelResponsePart2>): string | null {
		if (!this._leakGuardEvaluated) {
			this._leakGuardEvaluated = true;
			if (this._sawReasoningDelta && this.hasUnbalancedCodeSpan(this._reasoningAccum)) {
				this._leakGuardActive = true;
				logger.debug("responses.thinkLeak.guardArmed", { modelId: this._modelId });
			}
		}
		if (!this._leakGuardActive) {
			return text;
		}
		this._leakGuardBuffer += text;
		const buf = this._leakGuardBuffer;

		// 见开标签：正常 XML think 流，非泄漏，flush 后走常规解析
		if (buf.includes("<think>") || buf.includes("<thinking>")) {
			this._leakGuardActive = false;
			this._leakGuardBuffer = "";
			return buf;
		}

		// 孤儿闭标签：确认泄漏。标签前转思考 part 补进折叠区，标签丢弃，标签后按正文
		const closeIdx = buf.search(/<\/think(ing)?>/);
		if (closeIdx !== -1) {
			const match = buf.slice(closeIdx).match(/^<\/think(ing)?>/);
			const tagLen = match ? match[0].length : 8;
			const leaked = buf.slice(0, closeIdx);
			const rest = buf.slice(closeIdx + tagLen);
			this._leakGuardActive = false;
			this._leakGuardBuffer = "";
			if (leaked) {
				this.bufferThinkingContent(leaked, progress);
			}
			this.reportEndThinking(progress);
			logger.warn("responses.thinkLeak.dropped", { modelId: this._modelId, leakedChars: leaked.length });
			// 剩余正文递归走常规路径（守卫已评估且退出，不会重入缓冲）
			if (rest) {
				this.processOutputTextChunk(rest, progress);
			}
			return null;
		}

		// 超上限：判误报，flush 为正文（延迟但正确）
		if (buf.length > OpenaiResponsesApi.LEAK_GUARD_CAP) {
			this._leakGuardActive = false;
			this._leakGuardBuffer = "";
			logger.warn("responses.thinkLeak.falsePositiveFlush", { modelId: this._modelId, bufferedChars: buf.length });
			return buf;
		}

		// 继续缓冲
		return null;
	}

	private processOutputTextChunk(text: string, progress: Progress<vscode.LanguageModelResponsePart2>): void {
		if (!text) {
			return;
		}
		const guarded = this.runLeakGuard(text, progress);
		if (guarded === null) {
			return;
		}
		text = guarded;
		// Process XML think blocks or text content (mutually exclusive)
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			// Only process text content if no XML think blocks were emitted
			const res = this.processTextContent(text, progress);
			if (res.emittedAny) {
				this._hasEmittedAssistantText = true;
			}
		}
	}
	/** OpenAI Responses 服务端工具 item 类型（服务端执行、结果不回客户端） */
	private static readonly SERVER_SIDE_TOOL_TYPES = new Set([
		"file_search_call",
		"web_search_call",
		"code_interpreter_call",
		"image_generation_call",
	]);

	/**
	 * 把服务端工具 item 转成同名 function call：
	 * - queries 等意图参数在 added item 上携带，转换发生在 added；
	 *   done 事件复用 _completedToolCallIndices / 缓冲去重防双发；
	 * - 客户端尝试执行后会把「不可用」错误回传模型，促其下轮改用可用工具（自愈闭环）；
	 * - 向 UI 发一条可见提示说明这张工具卡的来历（每请求至多一次）。
	 */
	private async handleServerSideToolItem(
		item: Record<string, unknown>,
		event: Record<string, unknown>,
		progress: Progress<vscode.LanguageModelResponsePart2>
	): Promise<void> {
		const toolType = String(item.type);
		const idx = typeof event.output_index === "number" ? event.output_index : 0;
		logger.warn("responses.serverTool.converted", {
			modelId: this._modelId,
			toolType,
			outputIndex: idx,
			itemId: item.id,
		});

		if (!this._serverToolNotified) {
			this._serverToolNotified = true;
			// ⚠️ 用码点转义写入（U+26A0 U+FE0F），防编辑工具损坏 emoji
			progress.report(
				new vscode.LanguageModelTextPart(
					"\n\n\u26A0\uFE0F 模型发生幻觉，调用了不存在的服务端工具 " +
						toolType +
						"；已自动转为错误结果回传，提醒模型改用本次请求提供的可用工具。\n\n"
				)
			);
		}

		if (this._completedToolCallIndices.has(idx) || this._toolCallBuffers.has(idx)) {
			return;
		}
		const args = JSON.stringify({ queries: Array.isArray(item.queries) ? item.queries : [] });
		this._toolCallBuffers.set(idx, {
			id: typeof item.id === "string" ? item.id : undefined,
			name: toolType,
			args,
		});
		await this.tryEmitBufferedToolCall(idx, progress);
	}
	private async processEvent(
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const eventType = typeof event.type === "string" ? event.type : "";
		if (!eventType) {
			return;
		}

		this.captureResponseIdFromEvent(event);

		switch (eventType) {
			case "error": {
				const errorText = JSON.stringify(event);
				console.error("[OAI Compatible Model Provider] Responses API streaming process error:", errorText);
				return;
			}

			// Output text delta events
			case "response.output_text.delta":
			case "response.refusal.delta": {
				const delta = this.coerceText(event.delta);
				// Skip empty deltas entirely: the gateway may send an empty delta right
				// before output_text.done (observed on new-api→qwen). They carry no
				// content and must not affect the fuse below.
				if (!delta) {
					return;
				}
				// Fuse: seeing any non-empty delta permanently disables the
				// done-event fallback, regardless of whether the content was emitted
				// as plain text or routed into XML think-block processing.
				this._sawTextDelta = true;
				this.processOutputTextChunk(delta, progress);
				return;
			}

			// Output text done events
			case "response.output_text.done": {
				// Fallback for gateways that only emit a final "done" payload (no deltas).
				// Once any delta was streamed the fuse is blown and the full text is
				// dropped — emitting it would duplicate the whole message.
				if (this._sawTextDelta) {
					return;
				}
				const text = this.coerceText(event.text);
				this.processOutputTextChunk(text, progress);
				return;
			}
			case "response.refusal.done": {
				return;
			}

			// Reasoning delta events
			case "response.reasoning.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary.delta":
			case "response.reasoning_summary_text.delta":
			case "response.thinking.delta":
			case "response.thinking_summary.delta":
			case "response.thought.delta":
			case "response.thought_summary.delta": {
				// Skip empty deltas (same gateway quirk as text deltas). A non-empty
				// reasoning delta blows the fuse so the done event cannot replay the
				// full reasoning text on top of the streamed deltas.
				if (this.coerceText(event.delta)) {
					this._sawReasoningDelta = true;
					this.processReasoningText(event, progress);
				}
				return;
			}

			// Reasoning done events
			case "response.reasoning.done":
			case "response.reasoning_text.done":
			case "response.reasoning_summary.done":
			case "response.reasoning_summary_text.done":
			case "response.thinking.done":
			case "response.thinking_summary.done":
			case "response.thought.done":
			case "response.thought_summary.done": {
				// Fuse: if any reasoning delta was streamed, or thinking was buffered
				// through XML think blocks in text deltas, drop the done payload —
				// it only replays content that was already emitted.
				if (this._sawReasoningDelta || this._everBufferedThinking) {
					this.reportEndThinking(progress);
					return;
				}

				this.processReasoningText(event, progress);
				this.reportEndThinking(progress);
				return;
			}

			// Tool call events
			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(event);
				const name = typeof event.name === "string" ? event.name : "";
				const chunk =
					eventType === "response.function_call_arguments.delta"
						? typeof event.delta === "string"
							? event.delta
							: ""
						: typeof event.arguments === "string"
							? event.arguments
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}

				if (eventType === "response.function_call_arguments.delta") {
					if (chunk) {
						buf.args += chunk;
					}
				} else if (chunk) {
					// "done" events typically provide the full argument string.
					// ⚠️ 仅在非空时整体覆盖：部分网关 done 事件会回空串，盲覆盖会把前面
					// delta 拼好的参数抹空 → 冲刷时退化成 "{}" 或丢弃，工具参数就错了。
					buf.args = chunk;
				}
				this._toolCallBuffers.set(idx, buf);

				// ⚠️ delta 阶段只累积、不发射（2026-08-23 重复工具卡事故修复）：
				// new-api→qwen 会把上一个调用的完整参数作为 delta 路由到下一个
				// item_id（delta 累积 ≠ done 权威，日志统计为慢性病）。污染 delta
				// 恰是完整 JSON 时，旧写法在 delta 阶段抢跑发射 → UI 出现上一调用
				// 的重复卡。发射统一收敛到 done/flush：done 携带权威完整参数，
				// 污染 delta 被整体覆盖后不留痕迹；无 done 的调用由 [DONE] 冲刷兜底。
				if (eventType === "response.function_call_arguments.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.output_item.added":
			case "response.output_item.done": {
				const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
				if (!item) {
					return;
				}
				// 服务端工具（file_search_call/web_search_call 等）：客户端无法执行，
				// 网关执行结果也不回客户端，模型拿它当回合产出 → 空响应或中途截断
				// （2026-08-23 qwen3.8-max 事故）。转成同名 function call 后，客户端
				// 报「不可用」错误回传模型，下轮自动改用真实工具，形成自愈闭环。
				if (typeof item.type === "string" && OpenaiResponsesApi.SERVER_SIDE_TOOL_TYPES.has(item.type)) {
					await this.handleServerSideToolItem(item, event, progress);
					return;
				}
				if (item.type !== "function_call") {
					return;
				}

				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(item);
				const name =
					typeof item.name === "string"
						? item.name
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).name === "string"
							? String((item.function as Record<string, unknown>).name)
							: "";
				const args =
					typeof item.arguments === "string"
						? item.arguments
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).arguments === "string"
							? String((item.function as Record<string, unknown>).arguments)
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}
				if (args) {
					if (eventType === "response.output_item.added") {
						// ⚠️ [方案 B，2026-08-23 防同类踩坑] added 事件携带的内联 arguments 进 `inlineArgs`
						// 槽，绝不写进 `args`：网关可能在 added 预填 "{}" 或部分参数，而真实参数靠后续
						// function_call_arguments.delta 送达。旧写法把内联值塞进 args 并立刻 tryEmit：
						// "{}" 能解析成功 → 发射空参数工具调用并标记该 index 完成 → 后续真实参数
						// delta 全部被丢弃（与 anthropic content_block_start 恒带 input:{} 是同一型雷，
						// 2026-08-22 glm-5.2 事故同源）。inlineArgs 只在冲刷时「整条流没来过任何 delta」
						// 才作为兜底（见 commonApi.flushToolCallBuffers 的优先级注释）。
						buf.inlineArgs = args;
					} else {
						// output_item.done 是协议终态（完整参数），覆盖安全。
						buf.args = args;
					}
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType == "response.output_item.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.completed":
			case "response.done": {
				// End of message - ensure thinking is ended and flush all tool calls
				await this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				// Capture usage from the completed event
				const usage = event.usage ?? (event.response as Record<string, unknown>)?.usage;
				if (usage && typeof usage === "object") {
					const u = usage as Record<string, unknown>;
					const outputDetails = u.output_tokens_details as Record<string, unknown> | undefined;
					this._usage = {
						prompt_tokens: Number(u.input_tokens ?? 0),
						completion_tokens: Number(u.output_tokens ?? 0),
						total_tokens: Number(u.total_tokens ?? 0),
						prompt_tokens_details: u.input_tokens_details
							? { cached_tokens: Number((u.input_tokens_details as Record<string, unknown>).cached_tokens ?? 0) }
							: undefined,
						completion_tokens_details:
							outputDetails && typeof outputDetails.reasoning_tokens === "number"
								? { reasoning_tokens: outputDetails.reasoning_tokens }
								: undefined,
					};
					logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
				}
				return;
			}
		}
	}

	private captureResponseIdFromEvent(event: Record<string, unknown>): void {
		if (this._responseId) {
			return;
		}

		const responseId = event.response_id;
		if (typeof responseId === "string" && responseId.trim()) {
			this._responseId = responseId;
			return;
		}

		const response = event.response;
		if (response && typeof response === "object" && !Array.isArray(response)) {
			const id = (response as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) {
				this._responseId = id;
			}
		}
	}

	private processReasoningText(
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	) {
		const candidates = [
			this.coerceText(event.delta),
			this.coerceText(event.text),
			this.coerceText((event as Record<string, unknown>).reasoning),
			this.coerceText((event as Record<string, unknown>).summary),
		].filter(Boolean);

		for (const chunk of candidates) {
			if (this.looksLikeReasoningConfigValue(chunk)) {
				continue;
			}
			// 累积 reasoning 全文供泄漏守卫判别（反引号奇偶）
			this._reasoningAccum += chunk;
			this.bufferThinkingContent(chunk, progress);
			break;
		}
	}

	private getCallIdFromEvent(event: Record<string, unknown>): string {
		const callIdRaw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
		return typeof callIdRaw === "string" ? callIdRaw : "";
	}

	async *createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }> {
		// Convert to Responses API format
		const input: ResponsesInputItem[] = [];

		// Add system prompt as a system message or via instructions
		if (systemPrompt) {
			input.push({
				role: "system",
				content: [{ type: "input_text", text: systemPrompt }],
				type: "message",
				id: `msg_sys_${Date.now()}`,
				status: "completed",
			});
		}

		// Add user/assistant messages
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system" ? msg.role : "user";
			input.push({
				role,
				content: [{ type: "input_text", text: msg.content }],
				type: "message",
				id: `msg_${Date.now()}_${i}`,
				status: "completed",
			});
		}

		// Build request body
		let requestBody: Record<string, unknown> = {
			model: model.id,
			input,
			stream: true,
		};

		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai-responses", model.headers);

		const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

		// Make the API request
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI Responses API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from OpenAI Responses API");
		}

		// Process SSE streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						const eventType = typeof parsed.type === "string" ? parsed.type : "";

						// Only handle text output events, skip reasoning/thinking events
						const textOutputEvents = ["response.output_text.delta"];

						const isTextEvent = textOutputEvents.includes(eventType) || !eventType; // Also support events without explicit type

						if (isTextEvent) {
							// Extract text from various possible locations
							const textSources = [parsed.delta, parsed.text, parsed.content, parsed.output?.[0]?.content?.[0]?.text];

							for (const textSource of textSources) {
								if (typeof textSource === "string" && textSource) {
									yield { type: "text", text: textSource };
									break;
								}
							}
						}

						// Check for completion
						if (parsed.done || parsed.type === "response.completed" || parsed.type === "response.done") {
							break;
						}
					} catch (e) {
						console.error("[OpenAI-Responses Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
