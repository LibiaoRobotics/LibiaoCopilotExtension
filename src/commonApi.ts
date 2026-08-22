import * as vscode from "vscode";
import {
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatRequestMessage,
	LanguageModelToolCallPart,
	LanguageModelResponsePart2,
	LanguageModelThinkingPart,
	Progress,
	CancellationToken,
} from "vscode";
import { HFModelItem, CustomDataPartMimeTypes, TokenUsage } from "./types";
import { tryParseJSONObject } from "./utils";
import { logger } from "./logger";
import { VersionManager } from "./versionManager";

export abstract class CommonApi<TMessage, TRequestBody> {
	/** Buffer for assembling streamed tool calls by index. */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	protected _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	protected _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	protected _emittedBeginToolCallsHint = false;

	/**
	 * Monotonic fuse: set once ANY thinking content has been buffered, via
	 * reasoning deltas OR XML think blocks in text. Consumers use it to drop
	 * later "done"-style replay events. Never reset (2026-08-15, replaces the
	 * old reset-prone _hasEmittedThinking).
	 */
	protected _everBufferedThinking = false;

	// XML think block parsing state
	protected _xmlThinkActive = false;
	/** 当前激活 think 块对应的闭合标签（兼容 </think> 与 </thinking> 两种标签族） */
	protected _xmlThinkEndTag = "</think>";
	/** 跨 chunk 的被截断标签前缀挂起缓冲（标签在 chunk 边界被切开时暂存尾部） */
	protected _xmlThinkPending = "";

	// Thinking content state management
	protected _currentThinkingId: string | null = null;

	/** Buffer for accumulating thinking content before emitting. */
	protected _thinkingBuffer = "";

	/** Timer for delayed flushing of thinking buffer. */
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	/** System prompts to include in requests. */
	protected _systemContent: string | undefined;

	/** Set the model ID for logging purposes. */
	protected _modelId = "";

	/** Accumulated token usage from the API response. */
	protected _usage: TokenUsage | null = null;

	/**
	 * 读取本次请求捕获的服务端 token 用量（会话统计用）。
	 */
	getUsage(): TokenUsage | null {
		return this._usage;
	}

	constructor(modelId: string) {
		this._modelId = modelId;
	}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): TMessage[];

	/**
	 * Construct request body for Specific api
	 * @param rb Specific api Request body
	 * @param um Current Model Info
	 * @param options From VS Code
	 */
	abstract prepareRequestBody(
		rb: TRequestBody,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): TRequestBody;

	/**
	 * Process specific api streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	abstract processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void>;

	/**
	 * Create a message stream for the specific API.
	 * @param model The model to use.
	 * @param systemPrompt The system prompt to use.
	 * @param messages The messages to send.
	 * @param baseUrl The base URL for the API.
	 * @param apiKey The API key to use.
	 * @returns An async iterable of text chunks.
	 */
	abstract createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }>;

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		let parameters = canParse.value;
		parameters = this.adjustReadFileParameters(buf.name, parameters);
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			// [FIX] Normalize empty args to "{}" for parameterless tool calls
			const argsText = buf.args.trim() || "{}";
			const parsed = tryParseJSONObject(argsText);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			let parameters = parsed.value;
			parameters = this.adjustReadFileParameters(name, parameters);
			progress.report(new LanguageModelToolCallPart(id, name, parameters));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	/**
	 * Adjust read_file tool parameters to default to reading configurable number of lines.
	 * @param toolName The name of the tool being called.
	 * @param parameters The tool parameters.
	 * @returns Adjusted parameters.
	 */
	protected adjustReadFileParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
		if (toolName !== "read_file") {
			return parameters;
		}
		const config = vscode.workspace.getConfiguration();
		const defaultLines = config.get<number>("libiaoCopilot.readFileLines", 0);
		if (defaultLines <= 0) {
			return parameters;
		}

		const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
		const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
		if (endLine < startLine + defaultLines) {
			return { ...parameters, endLine: startLine + defaultLines };
		}
		return parameters;
	}

	/**
	 * Report to VS Code for ending thinking
	 * @param progress Progress reporter for parts
	 */
	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (!this._currentThinkingId) {
			return;
		}
		// Always clean up state after attempting to end the thinking sequence
		try {
			this.flushThinkingBuffer(progress);
			// End the current thinking sequence with empty content and same ID
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
		} catch (e) {
			console.error("[OAI Compatible Model Provider] Failed to end thinking sequence:", e);
		}
		this._currentThinkingId = null;
		// Clear thinking buffer and timer since sequence ended
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	/**
	 * Generate a unique thinking ID based on request start time and random suffix
	 */
	protected generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Buffer and schedule a flush for thinking content.
	 * @param text The thinking text to buffer
	 * @param progress Progress reporter for parts
	 */
	protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		this._everBufferedThinking = true;
		// Generate thinking ID if not provided by the model
		if (!this._currentThinkingId) {
			this._currentThinkingId = this.generateThinkingId();
		}

		// Append to thinking buffer
		this._thinkingBuffer += text;

		// Schedule flush with 100ms delay
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	/**
	 * Flush the thinking buffer to the progress reporter.
	 * @param progress Progress reporter for parts.
	 */
	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		// Always clear existing timer first
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}

		// Flush current buffer if we have content
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}

	/**
	 * Prepare headers for API request.
	 * @param apiKey The API key to use.
	 * @param apiMode The apiMode (affects header format).
	 * @param customHeaders Optional custom headers from model config.
	 * @returns Headers object.
	 */
	public static prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": VersionManager.getUserAgent(),
		};

		// Provider-specific header formats
		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
			headers["Accept"] = "text/event-stream";
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		// Merge custom headers
		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}

		return headers;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	protected processTextContent(input: string, progress: Progress<LanguageModelResponsePart2>): { emittedAny: boolean } {
		// 跳过纯空白块：不发射、也不计入"已发射正文"（否则前导空白会永久关闭 think 标签探测）
		if (!input || input.trim().length === 0) {
			return { emittedAny: false };
		}
		progress.report(new vscode.LanguageModelTextPart(input));
		this._hasEmittedAssistantText = true;
		return { emittedAny: true };
	}

	/**
	 * 各链路共享的文本输出统一入口：先尝试 XML think 块解析；
	 * 未命中 think 标签时，关闭思考序列并按正文发射。
	 * 防止裸 <think>/<thinking> 标签泄漏到可见正文，并保证思考/正文顺序正确。
	 */
	protected processStreamedTextChunk(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		if (!text) {
			return;
		}
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			this.reportEndThinking(progress);
			this.processTextContent(text, progress);
		}
	}

	/**
	 * Process streamed text content for XML think blocks and buffer thinking content.
	 * Returns whether any XML think tags were processed (preventing text fallback).
	 */
	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		// 已发射真实正文后停止找 think 标签（之后的 <think> 更可能是字面内容）；
		// think 块激活期间始终继续解析。
		// 取代旧的一次性 _xmlThinkDetectionAttempted：旧逻辑在首个无标签 chunk
		// （如前导空白）后就永久禁用解析，导致大段思考被当正文显示（2026-08-22 修复）。
		if (this._hasEmittedAssistantText && !this._xmlThinkActive) {
			return { emittedAny: false };
		}

		// 不同模型族 think 标签不同（Qwen/DeepSeek/GLM: <think>，部分旧模型: <thinking>）
		const START_TAGS = ["<think>", "<thinking>"];
		const END_TAGS = ["</think>", "</thinking>"];

		// 拼接上一块挂起的截断标签前缀
		let data = this._xmlThinkPending + input;
		this._xmlThinkPending = "";
		let emittedAny = false;

		// 返回串尾被截断的标签前缀长度（无则 0）：如 "<thi" 是 "<think>" 的前缀
		const partialTagTail = (s: string, tags: string[]): number => {
			for (const tag of tags) {
				const max = Math.min(tag.length - 1, s.length);
				for (let L = max; L >= 1; L--) {
					if (s.endsWith(tag.slice(0, L))) {
						return L;
					}
				}
			}
			return 0;
		};

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				// Look for the earliest-appearing think start tag
				let startIdx = -1;
				let tagLen = 0;
				for (let i = 0; i < START_TAGS.length; i++) {
					const idx = data.indexOf(START_TAGS[i]);
					if (idx !== -1 && (startIdx === -1 || idx < startIdx)) {
						startIdx = idx;
						tagLen = START_TAGS[i].length;
						this._xmlThinkEndTag = END_TAGS[i];
					}
				}
				if (startIdx === -1) {
					// 无完整开始标签：尾部截断前缀挂起等下一块，其余按正文发射。
					// 无论发射还是挂起，本块都已被消费（emittedAny=true），调用方不得重发。
					const partial = partialTagTail(data, START_TAGS);
					const emitPart = data.slice(0, data.length - partial);
					this._xmlThinkPending = data.slice(data.length - partial);
					if (emitPart) {
						this.reportEndThinking(progress);
						this.processTextContent(emitPart, progress);
					}
					emittedAny = true;
					data = "";
					break;
				}

				// Emit any plain text preceding the think start tag: once a tag is
				// processed in this chunk (emittedAny=true) the caller will not
				// re-emit the input, so the prefix must be emitted here.
				if (startIdx > 0) {
					this.reportEndThinking(progress);
					this.processTextContent(data.slice(0, startIdx), progress);
				}

				// Found think start tag - mark that we processed XML tags
				emittedAny = true;
				this._xmlThinkActive = true;

				// Skip the start tag and continue processing
				data = data.slice(startIdx + tagLen);
				continue;
			}

			// We are inside a think block, look for the end tag matching the active start tag
			const endIdx = data.indexOf(this._xmlThinkEndTag);
			if (endIdx === -1) {
				// 无完整闭合标签：尾部截断前缀挂起，其余缓冲为思考内容
				const partial = partialTagTail(data, [this._xmlThinkEndTag]);
				const bufferPart = data.slice(0, data.length - partial);
				this._xmlThinkPending = data.slice(data.length - partial);
				if (bufferPart) {
					this.bufferThinkingContent(bufferPart, progress);
				}
				emittedAny = true;
				data = "";
				break;
			}

			// Found end tag, buffer final thinking content before the end tag
			const thinkContent = data.slice(0, endIdx);
			this.bufferThinkingContent(thinkContent, progress);

			// Mark end tag as processed and reset state
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + this._xmlThinkEndTag.length);
		}

		return { emittedAny };
	}

	/**
	 * Report accumulated token usage as a LanguageModelDataPart so VS Code
	 * can display usage stats in the Context Window widget.
	 */
	protected reportUsage(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this._usage) {
			return;
		}
		logger.info("usage.report", { modelId: this._modelId, usage: this._usage });
		try {
			const bytes = new TextEncoder().encode(JSON.stringify(this._usage));
			progress.report(new vscode.LanguageModelDataPart(bytes, CustomDataPartMimeTypes.Usage));
		} catch (e) {
			logger.error("usage.report.error", { modelId: this._modelId, error: e instanceof Error ? e.message : String(e) });
		}
	}
}
