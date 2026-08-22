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
	/**
	 * Buffer for assembling streamed tool calls by index.
	 *
	 * ⚠️ 字段分工（方案 B，2026-08-23 踩坑后重构）：
	 * - `args`       只装「流式 delta 逐块拼接」出来的参数文本，是发射的第一优先来源。
	 * - `inlineArgs` 只装「start/added 事件里一次性给出的完整参数」（JSON 字符串）。
	 *   它【绝不能】拼进 `args`，只能在「整条流一个 delta 都没来」时作为兜底使用。
	 *
	 * 踩坑实录：Anthropic 官方协议 `content_block_start` 的 tool_use 恒带 `input: {}` 占位，
	 * 真实参数全靠后续 `input_json_delta` 送达。曾把 `{}` 直接拼进 `args`，导致
	 * `args = {}{"cmd":...}`，JSON.parse 永远失败 → 工具调用全部被静默丢弃 → 宿主报「no response」。
	 */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string; inlineArgs?: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string; inlineArgs?: string }
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
		// ⚠️ 流中发射只认 `args`（流式拼接结果），【绝不】用 `inlineArgs` 抢跑。
		// 踩坑：start 事件内联的 `input:{}` 是占位符，真实参数在后续 delta 才到；
		// 若在此用 inline 发射会发出「空参数工具调用」并清空缓冲，后续真实参数全丢。
		// inlineArgs 的兜底统一留给 flushToolCallBuffers（此时已知「是否来过 delta」）。
		if (!buf.args.trim()) {
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
			// ⚠️ [方案 B] 发射来源优先级（2026-08-23 踩坑后确立，勿改顺序）：
			//   1. 只要收到过流式 delta（args 非空）→ 一律以 args 为准；
			//   2. 一个 delta 都没来（args 为空）→ 回退 inlineArgs（非流式网关 start 带完整参数的兜底）；
			//   3. inlineArgs 也没有 → 视为无参工具调用 "{}"。
			// 教训：绝不能把 start 内联 input 拼进 args（Anthropic 协议 start 恒带 input:{} 占位），
			// 否则 args 变成 {}{...}，JSON.parse 必失败，工具调用被静默丢弃。
			const hasStreamedArgs = buf.args.trim().length > 0;
			const argsText = hasStreamedArgs ? buf.args : buf.inlineArgs ?? "{}";
			const parsed = tryParseJSONObject(argsText);
			if (!parsed.ok) {
				// 静默丢弃会让这类故障极难排查（本次事故就卡在这），因此无论是否 throw 都打一条 warn。
				logger.warn("toolCall.flush.invalidJson", {
					index: idx,
					name: buf.name ?? "unknown_tool",
					hasStreamedArgs,
					snippet: argsText.slice(0, 200),
				});
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: argsText.slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop to reduce noise（但上面已留 warn 记录）
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
			// End the current thinking sequence with empty content and same ID.
			// 携带官方结束哨兵 { vscode_reasoning_done: true }（对齐官方扩展
			// languageModelAccess.ts 姿势）：宿主 BYOK 处理器显式识别该元数据作为
			// 思考结束信号，不再依赖"空值不合并"的隐式规则兜底。
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId, { vscode_reasoning_done: true }));
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
		if (!input) {
			return { emittedAny: false };
		}
		// ⚠️ [2026-08-23 换行丢失事故修复] 纯空白块【照常发射】，但【不计入】"已发射真实正文"：
		// - 发射：网关（new-api→qwen 等）会把段落分隔的 `\n\n` 作为独立 delta 发送，
		//   吞掉它 = Markdown 段落结构塌缩（"## 标题\n\n1." 黏成 "## 标题1."，列表/加粗全废）。
		// - 不计入标志：前导空白若置位 _hasEmittedAssistantText，会永久关闭
		//   XML think 标签探测（2026-08-22 门控的本意），导致思考被当正文显示。
		// 两个行为必须拆开——旧实现把"不置标志"做成了"整块吞掉"，是本次事故根因。
		// emittedAny 语义保持"发射了非空白正文"不变，调用方零改动。
		if (input.trim().length === 0) {
			progress.report(new vscode.LanguageModelTextPart(input));
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
		// 已发射真实正文、或已经过原生思考缓冲（reasoning_content / reasoning_details /
		// thinking 字段 / Responses reasoning_text.delta）后，停止找 think 标签——
		// 此时的 content 是干净正文，里面的  是字面内容（如提示词示例），
		// 若继续解析会被误判为思考开始、吞掉其后全部正文（回放实证：吞 37 字符）。
		// think 块激活期间（_xmlThinkActive）始终继续解析，不受此门控影响。
		// 取代旧的一次性 _xmlThinkDetectionAttempted：旧逻辑在首个无标签 chunk
		// （如前导空白）后就永久禁用解析，导致大段思考被当正文显示（2026-08-22 修复）。
		// 门控命中前先冲刷挂起缓冲：正文跨块时（如 "Array" + "<" + "string>"），
		// 上一块的截断标签前缀会卡在 pending 里——若不冲刷，这部分字符永久丢失。
		// 一旦命中门控，pending 不可能再拼成思考开始标签，按正文发射即可。
		if ((this._hasEmittedAssistantText || this._everBufferedThinking) && !this._xmlThinkActive) {
			if (this._xmlThinkPending) {
				const pending = this._xmlThinkPending;
				this._xmlThinkPending = "";
				this.processTextContent(pending, progress);
			}
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
	 * 流结束时冲刷 XML think 挂起缓冲（_xmlThinkPending）。
	 * 正文恰好以截断标签前缀结尾（如泛型/HTML 片段的 "<"、"<th"）时，
	 * 挂起内容等不到下一块，不冲刷就会静默丢失（最多丢标签长度-1 个字符）。
	 * 各流处理器在 finally 中调用，顺序：先本方法、后 reportEndThinking
	 * （think 块激活时挂起属于思考内容，先进思考缓冲再随收尾冲刷）。
	 */
	protected flushXmlThinkPending(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this._xmlThinkPending) {
			return;
		}
		const pending = this._xmlThinkPending;
		this._xmlThinkPending = "";
		if (this._xmlThinkActive) {
			// think 块内：挂起是闭合标签的截断前缀，归入思考内容
			this.bufferThinkingContent(pending, progress);
		} else {
			// think 块外：挂起是开始标签的截断前缀，流已终止不可能再拼成完整标签——按正文发射
			this.processTextContent(pending, progress);
		}
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
