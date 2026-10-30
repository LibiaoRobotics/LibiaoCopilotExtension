import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";

import type {
	AnthropicMessage,
	AnthropicRequestBody,
	AnthropicContentBlock,
	AnthropicCacheControl,
	AnthropicTextBlock,
	AnthropicToolUseBlock,
	AnthropicToolResultBlock,
	AnthropicStreamChunk,
} from "./anthropicTypes";

import {
	getHostThinkingOverride,
	isImageMimeType,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAI,
	mapRole,
} from "../utils";

import { CommonApi, CommitStreamChunk } from "../commonApi";
import { logger } from "../logger";

export class AnthropicApi extends CommonApi<AnthropicMessage, AnthropicRequestBody> {
	/**
	 * Whether Anthropic prompt-caching breakpoints should be emitted on system / tools / messages.
	 * When false, behave like prior versions (no `cache_control` anywhere in the request).
	 */
	private readonly _cacheControlEnabled: boolean;

	/**
	 * 本条流是否已收到过原生思考块（thinking 块开始 / thinking_delta）。
	 * 一旦出现原生思考块，text_delta 就是干净正文，直接发射、不走 XML think 解析——
	 * 否则正文里的字面量 think 开标签会被误判为思考开始，其后全部正文被吞进
	 * 思考缓冲，聊天框观感即"消息被截断"（2026-08-22 glm-5.2 事故，回放实证）。
	 * 翻译层网关的流没有原生思考块（思考内联进 text），保持 XML 解析防标签泄漏。
	 */
	private _sawNativeThinkingBlock = false;

	/**
	 * 当前 thinking 块的 `signature`。Anthropic 要求重放思考块时**原样带回**签名，
	 * 缺签名或被改写都会让整个请求 400。仅当宿主请求加密思考状态
	 * （`includeEncryptedThinking`）时才通过 thinking 分片 metadata 上报。
	 */
	private _currentThinkingSignature: string | null = null;

	/** 宿主（较新 Copilot Chat）是否要求响应携带可跨轮重放的加密思考状态。 */
	private readonly _includeEncryptedThinking: boolean;

	constructor(modelId: string, cacheControlEnabled = true, includeEncryptedThinking = false) {
		super(modelId);
		this._cacheControlEnabled = cacheControlEnabled;
		this._includeEncryptedThinking = includeEncryptedThinking;
	}

	/**
	 * Decode a `LanguageModelDataPart` whose `mimeType` is `"cache_control"` into a real
	 * Anthropic `cache_control` value. The host (Copilot) encodes the breakpoint payload as a
	 * UTF-8 JSON string (e.g. `{"type":"ephemeral"}`). Falls back to `{type:"ephemeral"}` if
	 * the payload is empty or malformed.
	 */
	private decodeCacheControlPart(part: vscode.LanguageModelDataPart): AnthropicCacheControl {
		const fallback: AnthropicCacheControl = { type: "ephemeral" };
		try {
			const text = new TextDecoder().decode(part.data);
			if (!text) {
				return fallback;
			}
			const parsed = JSON.parse(text) as { type?: string; ttl?: string };
			if (parsed && typeof parsed === "object" && parsed.type === "ephemeral") {
				const cc: AnthropicCacheControl = { type: "ephemeral" };
				if (parsed.ttl === "1h" || parsed.ttl === "5m") {
					cc.ttl = parsed.ttl;
				}
				return cc;
			}
		} catch {
			/* fall through */
		}
		return fallback;
	}

	/**
	 * Convert VS Code chat messages to Anthropic message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Anthropic-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): AnthropicMessage[] {
		const out: AnthropicMessage[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: AnthropicToolUseBlock[] = [];
			const toolResults: AnthropicToolResultBlock[] = [];
			const thinkingParts: string[] = [];
			// 加密思考状态：signature 用于正常 thinking 块，redactedData 用于加密块。
			let thinkingSignature: string | undefined;
			let redactedThinkingData: string | undefined;
			// Cache breakpoints emitted by the host (Copilot) via LanguageModelDataPart(mimeType="cache_control").
			// We mark the position in the constructed content-block list where each breakpoint should land.
			// Breakpoints appearing before any other content fall back to the first block; after-all
			// breakpoints fall back to the last block. Multiple breakpoints in the same message are honored,
			// each attached to the latest block at the time the marker was seen.
			const pendingCacheControls: { afterPartIndex: number; cc: AnthropicCacheControl }[] = [];
			let collectedParts = 0;

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
					collectedParts++;
				} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "cache_control") {
					if (this._cacheControlEnabled) {
						pendingCacheControls.push({
							afterPartIndex: collectedParts,
							cc: this.decodeCacheControlPart(part),
						});
					}
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
					collectedParts++;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					toolCalls.push({
						type: "tool_use",
						id,
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					});
					collectedParts++;
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({
						type: "tool_result",
						tool_use_id: callId,
						content,
					});
					collectedParts++;
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
					const metadata = part.metadata as Record<string, unknown> | undefined;
					if (metadata) {
						if (!thinkingSignature && typeof metadata.signature === "string" && metadata.signature) {
							thinkingSignature = metadata.signature;
						}
						if (!redactedThinkingData && typeof metadata.redactedData === "string" && metadata.redactedData) {
							redactedThinkingData = metadata.redactedData;
						}
					}
					collectedParts++;
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// Handle system messages separately (Anthropic uses top-level system field)
			if (role === "system") {
				if (joinedText) {
					this._systemContent = this._systemContent
						? `${this._systemContent}\n\n${joinedText}`
						: joinedText;
				}
				continue;
			}

			// Build content blocks for user/assistant messages
			const contentBlocks: AnthropicContentBlock[] = [];

			// Add thinking content for assistant messages.
			// Anthropic 要求思考块位于助手消息内容的最前面（thinking 启用时），
			// 因此必须先于 text / image 落位。
			if (role === "assistant") {
				if (redactedThinkingData) {
					// 加密思考块只能原样回放（上游据此恢复被隐藏的推理过程）。
					contentBlocks.push({
						type: "redacted_thinking",
						data: redactedThinkingData,
					});
				}
				if (joinedThinking && thinkingSignature) {
					// 带签名的思考块：签名必须与思考文本一起原样回放，否则 Anthropic 直接 400。
					contentBlocks.push({
						type: "thinking",
						thinking: joinedThinking,
						signature: thinkingSignature,
					});
				} else if (modelConfig.includeReasoningInRequest) {
					// 无签名时的旧行为（用户显式开启 include_reasoning_in_request）：
					// 保留占位思考块，避免对既有可用配置造成回归。
					contentBlocks.push({
						type: "thinking",
						thinking: joinedThinking || "Next step.",
					});
				}
			}

			// Add text content
			if (joinedText) {
				contentBlocks.push({
					type: "text",
					text: joinedText,
				});
			}

			// Add image content
			for (const imagePart of imageParts) {
				const base64Data = Buffer.from(imagePart.data).toString("base64");
				contentBlocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: imagePart.mimeType,
						data: base64Data,
					},
				});
			}

			// Add tool calls for assistant messages
			for (const toolCall of toolCalls) {
				contentBlocks.push(toolCall);
			}

			// For tool results, they should be added to user messages
			// We'll add them to the current message if it's a user message
			if (role === "user" && toolResults.length > 0) {
				for (const toolResult of toolResults) {
					contentBlocks.push(toolResult);
				}
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				console.warn("[Anthropic Provider] Tool results found in non-user message, ignoring");
				logger.warn("anthropic.tool-results.non-user", {
					messageRole: role,
					toolResultCount: toolResults.length,
				});
			}

			// Apply pending cache_control markers to the appropriate block. The block order we built
			// above does not always map 1:1 to the original part order (text is joined, tool results
			// migrate, etc.), so we approximate: a marker that arrived after K source parts is attached
			// to the block at index min(K-1, blocks.length-1). Markers seen before any part go on block 0.
			for (const { afterPartIndex, cc } of pendingCacheControls) {
				if (contentBlocks.length === 0) {
					continue;
				}
				const target = Math.min(Math.max(afterPartIndex - 1, 0), contentBlocks.length - 1);
				contentBlocks[target].cache_control = cc;
			}

			// Only add message if we have content blocks
			if (contentBlocks.length > 0) {
				out.push({
					role,
					content: contentBlocks,
				});
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: AnthropicRequestBody,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): AnthropicRequestBody {
		// Set max_tokens (required for Anthropic; fall back to avoid 400 when unconfigured)
		if (um?.max_tokens !== undefined) {
			rb.max_tokens = um.max_tokens;
		} else if (um?.max_completion_tokens !== undefined) {
			rb.max_tokens = um.max_completion_tokens;
		} else {
			rb.max_tokens = 4096;
		}

		// Add system content if we extracted it. When caching is enabled, emit the system prompt
		// as a structured `text` block array carrying a `cache_control` breakpoint — without this,
		// Anthropic will never cache the (often very long) Copilot system prompt and every turn pays
		// full input cost. The string form remains the fallback when caching is disabled.
		if (this._systemContent) {
			if (this._cacheControlEnabled) {
				const systemBlock: AnthropicTextBlock = {
					type: "text",
					text: this._systemContent,
					cache_control: { type: "ephemeral" },
				};
				rb.system = [systemBlock];
			} else {
				rb.system = this._systemContent;
			}
		}

		// Add temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// Add top_p if configured
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// Add top_k if configured
		if (um?.top_k !== undefined) {
			rb.top_k = um.top_k;
		}

		// Add tools configuration
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Anthropic format
			rb.tools = toolConfig.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));
			// Mark the last tool with a cache_control breakpoint so the tool-definitions prefix is cached.
			// Tool definitions are large and stable across a session — this is one of the highest-value
			// breakpoints to set, and Anthropic counts everything up to and including this tool toward
			// the cached prefix on subsequent requests.
			if (this._cacheControlEnabled && rb.tools.length > 0) {
				rb.tools[rb.tools.length - 1].cache_control = { type: "ephemeral" };
			}
		}

		// Add tool_choice
		if (toolConfig.tool_choice) {
			if (toolConfig.tool_choice === "auto") {
				rb.tool_choice = { type: "auto" };
			} else if (typeof toolConfig.tool_choice === "object" && toolConfig.tool_choice.type === "function") {
				rb.tool_choice = { type: "tool", name: toolConfig.tool_choice.function.name };
			}
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			// Add all extra parameters directly to the request body
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					if (key === "tools" && Array.isArray(value) && rb.tools) {
						rb.tools = [...rb.tools, ...value];
					} else {
						(rb as unknown as Record<string, unknown>)[key] = value;
					}
				}
			}
		}

		// 宿主（Copilot Chat）显式关闭思考：`thinking` 只能由 extra 配置注入，
		// 这里统一摘除。旧版宿主不下发该字段，行为保持不变。
		if (getHostThinkingOverride(options) === false) {
			delete (rb as { thinking?: unknown }).thinking;
		}

		// Anthropic accepts at most 4 `cache_control` breakpoints per request. The host (Copilot)
		// may emit several breakpoints inside `messages` via its own caching strategy; combined with
		// the system + last-tool breakpoints we add above, the total can exceed the cap and the API
		// returns 400. Strip the *earliest* in-message breakpoints first — Anthropic's cache lookup
		// matches the longest cached prefix, so the most recent (rightmost) breakpoints carry the
		// most value, and the system / tools breakpoints sit at the very front of the prefix and
		// rarely change, so they're worth keeping.
		if (this._cacheControlEnabled) {
			this.enforceCacheControlBudget(rb);
		}

		return rb;
	}

	/**
	 * Anthropic accepts at most 4 `cache_control` breakpoints per request. This method counts
	 * every breakpoint currently set on `system`, `tools`, and each message content block, and
	 * if the total exceeds 4, strips breakpoints in a stable priority order:
	 *   1. In-message breakpoints, earliest first (least valuable — covers shortest prefix).
	 *   2. The tools breakpoint, if still over budget after step 1.
	 *   3. The system breakpoint, last (most valuable — covers longest stable prefix).
	 */
	private enforceCacheControlBudget(rb: AnthropicRequestBody): void {
		const MAX = 4;

		// Tally and locate every breakpoint we might need to strip.
		let total = 0;
		const systemBlocksWithCC: AnthropicTextBlock[] = [];
		const toolsWithCC: { name: string }[] = [];
		const msgBlocksWithCC: { cache_control?: AnthropicCacheControl }[] = [];

		if (Array.isArray(rb.system)) {
			for (const block of rb.system) {
				if (block.cache_control) {
					systemBlocksWithCC.push(block);
					total++;
				}
			}
		}
		if (rb.tools) {
			for (const tool of rb.tools) {
				if (tool.cache_control) {
					toolsWithCC.push(tool);
					total++;
				}
			}
		}
		for (const msg of rb.messages) {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					const b = block as { cache_control?: AnthropicCacheControl };
					if (b.cache_control) {
						msgBlocksWithCC.push(b);
						total++;
					}
				}
			}
		}

		if (total <= MAX) {
			return;
		}

		let toRemove = total - MAX;
		const removalLog: string[] = [];

		// Step 1: drop earliest in-message breakpoints (push-order == document order here because
		// we walked messages front-to-back, and each message's blocks front-to-back).
		for (const block of msgBlocksWithCC) {
			if (toRemove === 0) {
				break;
			}
			delete block.cache_control;
			toRemove--;
			removalLog.push("message");
		}

		// Step 2: drop tools breakpoint(s) if still over budget.
		for (const tool of toolsWithCC) {
			if (toRemove === 0) {
				break;
			}
			delete (tool as { cache_control?: unknown }).cache_control;
			toRemove--;
			removalLog.push("tool");
		}

		// Step 3: as a last resort, drop the system breakpoint(s).
		for (const block of systemBlocksWithCC) {
			if (toRemove === 0) {
				break;
			}
			delete block.cache_control;
			toRemove--;
			removalLog.push("system");
		}

		logger.debug("anthropic.cache_control.trim", {
			modelId: this._modelId,
			originalCount: total,
			finalCount: MAX,
			dropped: removalLog,
		});
	}

	/**
	 * Process Anthropic streaming response (SSE format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const modelId = this._modelId;
		logger.debug("anthropic.stream.start", { modelId });

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
					if (line.trim() === "") {
						continue;
					}
					if (!line.startsWith("data:")) {
						continue;
					}

					const data = line.slice(5).trim();
					logger.debug("anthropic.stream.chunk", { modelId, data });
					if (data === "[DONE]") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						continue;
					}

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);
						await this.processAnthropicChunk(chunk, progress);
					} catch (e) {
						console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
						logger.error("anthropic.stream.chunk.error", {
							modelId,
							error: e instanceof Error ? e.message : String(e),
							data,
						});
					}
				}
			}
			logger.debug("anthropic.stream.done", { modelId });
		} catch (e) {
			console.error("[Anthropic Provider] Streaming response error:", e);
			logger.error("anthropic.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
			// 冲刷 XML think 挂起缓冲（先于收尾：激活时挂起归入思考缓冲，随收尾同步冲刷）
			this.flushXmlThinkPending(progress);
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);
			// Report accumulated usage for the Context Window widget
			this.reportUsage(progress);
		}
	}

	/**
	 * Process a single Anthropic streaming chunk.
	 * @param chunk Parsed Anthropic stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processAnthropicChunk(
		chunk: AnthropicStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		// Handle ping events (ignore)
		if (chunk.type === "ping") {
			return;
		}

		// Handle error events
		if (chunk.type === "error") {
			const errorType = chunk.error?.type || "unknown_error";
			const errorMessage = chunk.error?.message || "Anthropic API streaming error";
			console.error(`[Anthropic Provider] Streaming error: ${errorType} - ${errorMessage}`);
			// We could throw here, but for now just log and continue
			return;
		}

		if (chunk.type === "message_start" && chunk.message) {
			// 官方协议：message_start 携带全量 usage（input_tokens + cache 明细）
			if (chunk.message.usage) {
				const inputTokens = chunk.message.usage.input_tokens ?? 0;
				const cacheCreateTokens = chunk.message.usage.cache_creation_input_tokens ?? 0;
				const cacheReadTokens = chunk.message.usage.cache_read_input_tokens ?? 0;
				this._usage = {
					prompt_tokens: inputTokens + cacheCreateTokens + cacheReadTokens,
					completion_tokens: chunk.message.usage.output_tokens ?? 0,
					total_tokens: inputTokens + cacheCreateTokens + cacheReadTokens + (chunk.message.usage.output_tokens ?? 0),
					prompt_tokens_details: {
						cached_tokens: cacheReadTokens,
					},
				};
				logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
			}
			return;
		}

		if (chunk.type === "message_delta") {
			// 官方协议：message_delta 只携带最终 output_tokens；但部分网关会把全量
			// input_tokens 也塞进 message_delta——存在时优先采用，缺失时保留 message_start 的 prompt 数据
			const u = chunk.usage as
				| {
						output_tokens?: number;
						input_tokens?: number;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
				  }
				| undefined;
			if (u && (u.output_tokens !== undefined || (typeof u.input_tokens === "number" && u.input_tokens > 0))) {
				const prev = this._usage;
				const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
				const hasInput = inputTokens > 0;
				const promptTokens = hasInput
					? inputTokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
					: (prev?.prompt_tokens ?? 0);
				const completionTokens = u.output_tokens ?? prev?.completion_tokens ?? 0;
				this._usage = {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: promptTokens + completionTokens,
					prompt_tokens_details: hasInput ? { cached_tokens: u.cache_read_input_tokens ?? 0 } : prev?.prompt_tokens_details,
				};
				logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
			}
			return;
		}

		if (chunk.type === "content_block_start" && chunk.content_block) {
			// Start of a content block
			if (chunk.content_block.type === "thinking") {
				// Start thinking block（原生思考块标记：后续 text_delta 按干净正文直接发射）
				this._sawNativeThinkingBlock = true;
				this._currentThinkingSignature = null;
				if (chunk.content_block.thinking) {
					this.bufferThinkingContent(chunk.content_block.thinking, progress);
				}
			} else if (chunk.content_block.type === "tool_use") {
				// Start tool call block
				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}
				const idx = (chunk.index as number) ?? 0;
				// ⚠️ [方案 B，2026-08-23 踩坑修复] 内联 input 与流式参数【分槽存放，绝不混拼】：
				// - args 恒为空串起点，只由后续 input_json_delta 逐块拼接；
				// - inlineArgs 存 start 事件携带的完整 input，仅当整条流没有来任何
				//   input_json_delta 时，才在冲刷阶段作为兜底（见 commonApi.flushToolCallBuffers）。
				//
				// 踩坑实录：Anthropic 官方协议 content_block_start 的 tool_use【恒带】 `input: {}`
				// 占位（非流式网关才会给非空完整参数）。旧实现把 `input` 直接 JSON.stringify
				// 后塞进 args → args = `{}{"cmd":...}` → JSON.parse 永远失败 →
				// 工具调用在 flush 时被静默丢弃 → 宿主只收到 thinking、判 Unknown、
				// 报「Sorry, no response was returned.」（glm-5.2 2026-08-22 事故）。
				// 若未来想优化「非流式网关」路径，只允许在「确认没有任何 delta 到达」后
				// 使用 inlineArgs，永远不要在此处预填 args。
				const hasInlineInput =
					chunk.content_block.input !== undefined &&
					typeof chunk.content_block.input === "object" &&
					chunk.content_block.input !== null;
				this._toolCallBuffers.set(idx, {
					id: chunk.content_block.id,
					name: chunk.content_block.name,
					args: "",
					inlineArgs: hasInlineInput ? JSON.stringify(chunk.content_block.input) : undefined,
				});
			} else if (chunk.content_block.type === "text") {
				// Text block start - nothing special to do
				// The text content will come via content_block_delta events
			}
		} else if (chunk.type === "content_block_delta" && chunk.delta) {
			if (chunk.delta.type === "text_delta" && chunk.delta.text) {
				if (this._sawNativeThinkingBlock) {
					// 原生思考链路（glm 等）：思考已走原生 thinking 块，text_delta 是干净正文。
					// 直接发射（旧行为），不做 XML 解析——正文字面量 think 开标签不再吞掉后续正文。
					// 注意：直发而非 processTextContent，保留纯空白块（代码的换行/缩进常单独成块，
					// processTextContent 会跳过纯空白，导致代码格式损坏）。
					this.reportEndThinking(progress);
					progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
					this._hasEmittedAssistantText = true;
				} else {
					// 未见原生思考块（翻译层网关可能把思考内联进 text）：XML 解析，防裸标签泄漏到正文
					this.processStreamedTextChunk(chunk.delta.text, progress);
				}
			} else if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
				// Buffer thinking content（原生思考块标记：后续 text_delta 按干净正文直接发射）
				this._sawNativeThinkingBlock = true;
				this.bufferThinkingContent(chunk.delta.thinking, progress);
			} else if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
				// Handle tool call argument streaming
				// Find the latest tool call buffer and append partial JSON
				const idx = (chunk.index as number) ?? 0;
				const buf = this._toolCallBuffers.get(idx);
				if (buf) {
					buf.args += chunk.delta.partial_json;
					this._toolCallBuffers.set(idx, buf);
					// Try to emit if we have valid JSON
					await this.tryEmitBufferedToolCall(idx, progress);
				}
			} else if (chunk.delta.type === "signature_delta" && chunk.delta.signature) {
				// Anthropic 的思考签名：重放历史轮次时必须原样带回，否则请求 400。
				this._currentThinkingSignature = (this._currentThinkingSignature ?? "") + chunk.delta.signature;
			}
		} else if (chunk.type === "content_block_stop" || chunk.type === "message_stop") {
			// 思考块的签名在 content_block_stop 之前送达；在结束思考序列前交给基类，
			// 由 reportEndThinking 于结束哨兵之前以内容分片上报。
			if (this._includeEncryptedThinking && this._currentThinkingSignature) {
				this.setPendingThinkingMetadata({ signature: this._currentThinkingSignature });
			}
			this._currentThinkingSignature = null;
			// End of message - ensure thinking is ended and flush all tool calls
			await this.flushToolCallBuffers(progress, false);
			this.reportEndThinking(progress);
		}
	}

	async *createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal
	): AsyncGenerator<CommitStreamChunk> {
		// For Anthropic, we need to separate system prompt from messages
		const anthropicMessages: AnthropicMessage[] = messages.map((m) => ({
			role: m.role === "user" || m.role === "assistant" ? m.role : "user",
			content: m.content,
		}));
		this._systemContent = systemPrompt;

		// requestBody
		let requestBody: AnthropicRequestBody = {
			model: model.id,
			messages: anthropicMessages,
			stream: true,
		};
		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers);

		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
		// The base URL carries the API version prefix (e.g.
		// https://api.anthropic.com/v1); we append the Messages endpoint.
		const url = `${normalizedBaseUrl}/messages`;

		// Make the API request
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from Anthropic API");
		}

		// Process the response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		/** 是否收到过终止信号（message_stop / [DONE]）。 */
		let terminated = false;
		/** message_start / message_delta 里的 stop_reason，用于识别 max_tokens 截断。 */
		let stopReason: string | undefined;
		/** 流内 error 事件：服务端中途报错，不能当正常结束。 */
		let streamError = "";

		// 单行解析：返回该行携带的正文增量，同时记录终止信号与 stop_reason。
		const parseLine = (rawLine: string): string | undefined => {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) {
				return undefined;
			}
			const data = line.slice(5).trim();
			if (!data) {
				return undefined;
			}
			if (data === "[DONE]") {
				terminated = true;
				return undefined;
			}

			try {
				const chunk: AnthropicStreamChunk = JSON.parse(data);

				// text_delta 是正文；thinking / input_json / signature 分片不属于提交信息正文。
				if (chunk.delta?.type === "text_delta" && chunk.delta.text) {
					return chunk.delta.text;
				}

				// stop_reason 分两处送达：message_start 的 message 与 message_delta 的 delta。
				const reason = chunk.delta?.stop_reason ?? chunk.message?.stop_reason;
				if (typeof reason === "string" && reason) {
					stopReason = reason;
				}

				if (chunk.type === "message_stop") {
					terminated = true;
					return undefined;
				}

				if (chunk.type === "error") {
					// 记下服务端错误：流可能就此断掉，不能只打 console 当无事发生。
					const errorType = chunk.error?.type || "unknown_error";
					const errorMessage = chunk.error?.message || "Anthropic API streaming error";
					streamError = `${errorType}: ${errorMessage}`;
					terminated = true;
				}
			} catch (e) {
				console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
			}
			return undefined;
		};

		try {
			while (!terminated) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const text = parseLine(line);
					if (text) {
						yield { type: "text", text };
					}
					if (terminated) {
						break;
					}
				}
			}

			// 收尾：解码器与行缓冲里可能还留着最后一段（末尾无换行时不会被 split 出来）。
			buffer += decoder.decode();
			if (!terminated && buffer.trim()) {
				const text = parseLine(buffer);
				if (text) {
					yield { type: "text", text };
				}
			}
		} finally {
			reader.releaseLock();
		}

		// 流结束校验：区分「正常结束」「服务端截断」「异常结束」。
		if (streamError) {
			console.error(`[Anthropic Provider] Streaming error: ${streamError}`);
			yield { type: "incomplete", reason: "failed" };
		} else if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
			yield { type: "incomplete", reason: "length" };
		} else if (stopReason === "refusal") {
			yield { type: "incomplete", reason: "failed" };
		} else if (!terminated && !stopReason) {
			yield { type: "incomplete", reason: "unexpected-end" };
		}
	}
}
