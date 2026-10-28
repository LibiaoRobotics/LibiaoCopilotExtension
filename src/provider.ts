import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "./types";
import type { TokenUsage } from "./types";
import { CustomDataPartMimeTypes } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels, getBuiltInModel, asRateLimitedError, withRetryAfter } from "./utils";

import { prepareLanguageModelChatInformation, NO_MODELS_PLACEHOLDER_ID } from "./provideModel";
import { countMessageTokens } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { SessionStats } from "./sessionStats";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { logger } from "./logger";
import { manageContext, type ContextManagementMode } from "./contextManager";
import { getConfiguredContextSize } from "./modelConfiguration";

/** 各适配层承载会话历史的请求体字段名：OpenAI/Anthropic/Ollama 用 messages，
 * Responses 用 input，Gemini 用 contents。 */
const HISTORY_PAYLOAD_KEYS: readonly string[] = ["input", "messages", "contents"];

/** 统计任意 JSON 结构中的字符总量（含内联图片的 base64 数据）。 */
function measureTextChars(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (Array.isArray(value)) {
		let total = 0;
		for (const item of value) {
			total += measureTextChars(item);
		}
		return total;
	}
	if (value && typeof value === "object") {
		let total = 0;
		for (const item of Object.values(value as Record<string, unknown>)) {
			total += measureTextChars(item);
		}
		return total;
	}
	return 0;
}

/** 取历史项的角色（Responses 的 function_call 等项没有 role，退化为 type）。 */
function describeHistoryItemRole(item: unknown): string {
	if (!item || typeof item !== "object") {
		return "?";
	}
	const record = item as Record<string, unknown>;
	if (typeof record.role === "string" && record.role) {
		return record.role;
	}
	if (typeof record.type === "string" && record.type) {
		return record.type;
	}
	return "?";
}

/**
 * 把请求体里的会话历史压缩成骨架后再落盘。
 *
 * 整份历史会随每个请求重复写入 debug 日志，单请求 0.4~1.0MB、单日 900MB+，
 * 其中历史载荷占 46%，量级随会话长度线性增长。调参所需（reasoning、tools、
 * schema 等）全在其他字段上原样保留，历史本身换成条数/角色/字符数分布即可定位规模。
 * 结果带 `omittedHint`，避免读日志时误以为请求只发了这几项。
 * 导出仅供单元测试覆盖。
 */
export function summarizeRequestBodyForLog(requestBody: unknown): unknown {
	if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
		return requestBody;
	}
	const summary: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(requestBody as Record<string, unknown>)) {
		if (HISTORY_PAYLOAD_KEYS.includes(key) && Array.isArray(value)) {
			const roles: Record<string, number> = {};
			for (const item of value) {
				const role = describeHistoryItemRole(item);
				roles[role] = (roles[role] ?? 0) + 1;
			}
			summary[key] = {
				count: value.length,
				roles,
				chars: measureTextChars(value),
				omittedHint: "history omitted",
			};
		} else {
			summary[key] = value;
		}
	}
	return summary;
}

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	/** 模型级生成性能统计（按组合 ID 独立累计，不随会话切换重置） */
	private _sessionStats = new SessionStats();

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();

	/**
	 * 宿主（Copilot Chat）用于跨轮复用的 Responses 状态标记 MIME。
	 *
	 * 必须与宿主 `CustomDataPartMimeTypes.StatefulMarker`（`"stateful_marker"`）一致：
	 * 宿主只识别这一个值，自定义 MIME 会被静默丢弃，`previous_response_id`
	 * 链式复用随之完全失效（每轮都退化成重发全量历史）。
	 */
	static readonly OPENAI_RESPONSES_STATEFUL_MARKER_MIME = CustomDataPartMimeTypes.StatefulMarker;

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token, this.secrets);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		if (model.id === NO_MODELS_PLACEHOLDER_ID) {
			// Placeholder entry: no verified models exist, so never send a
			// request — fail fast with an actionable message.
			throw new Error("No models available. Please check the base URL and API Key configuration.");
		}
		// 会话统计：跟踪本次请求的首/末非空输出时刻（流式耗时用）
		let streamFirstMs: number | null = null;
		let streamLastMs: number | null = null;
		let textFirstMs: number | null = null;
		let textLastMs: number | null = null;
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					const now = Date.now();
					// 记录首/末非空输出时刻：任何 TextPart/ThinkingPart 都算（生成已开始）
					const isOutput = typeof part === "object" && part !== null &&
						("value" in part || "id" in part);
					if (isOutput) {
						if (streamFirstMs === null) {
							streamFirstMs = now;
						}
						streamLastMs = now;
					}
					// 记录纯正文（TextPart）输出时刻（供 Gemini 模式独立统计正文流式耗时）
					const isTextOutput =
						part instanceof vscode.LanguageModelTextPart &&
						typeof part.value === "string" &&
						part.value.length > 0;
					if (isTextOutput) {
						if (textFirstMs === null) {
							textFirstMs = now;
						}
						textLastMs = now;
					}
					progress.report(part);
				} catch (e) {
					console.error("[OAI Compatible Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		// 各 apiMode 实例的 usage 出口（finally 结算用）
		let currentApi: { getUsage(): TokenUsage | null } | null = null;
		// 协议模式（供 finally 结算区分 Gemini 独立正文统计）
		let actualApiMode: string = "openai";
		// 模型配置（try 内解析 um 后赋值；finally 刷新 tooltip 时需要）
		// includeEncryptedThinking：宿主（较新 Copilot Chat）要求响应携带可跨轮重放的
		// 加密思考状态（如 Anthropic thinking signature）。旧版宿主不下发该字段，
		// 因而为 undefined，各协议适配层必须按“不需要”处理。
		let modelConfig: { includeReasoningInRequest: boolean; includeEncryptedThinking?: boolean } = {
			includeReasoningInRequest: false,
		};
		const requestStartTime = Date.now();
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Auto-discovered models (exposed from the gateway listing without a
			// user configuration entry) have no `um` above; fall back to the
			// built-in factory entry so its apiMode and metadata apply to the
			// request instead of being silently lost to the "openai" default.
			if (!um) {
				um = getBuiltInModel(parsedModelId.baseId);
			}

			// Check if using Ollama native API mode
			const apiMode = um?.apiMode ?? "openai";
			actualApiMode = apiMode;
			const baseUrl = um?.baseUrl || config.get<string>("libiaoCopilot.baseUrl", "");

			logger.info("request.start", {
				modelId: model.id,
				messageCount: messages.length,
				apiMode,
				baseUrl,
			});

			// Prepare model configuration
			modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
				includeEncryptedThinking: options.includeEncryptedThinking === true,
			};

			// Update Token Usage
			try {
				// await 保证状态栏已是本次请求的进度条；计数失败仅告警、不影响请求本身
				// 统计按模型累计（不随会话切换重置）——原“消息条数骤降”会话检测在
				// 多会话并存时会误清空/混计，2026-08-23 移除
				await updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig, this._sessionStats, getConfiguredContextSize(options));
			} catch (e) {
				logger.warn("statusBar.update", {
					error: e instanceof Error ? e.message : String(e),
				});
			}

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("libiaoCopilot.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", {
						delayMs,
						elapsed,
						remainingDelay,
					});
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key for the model's provider
			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
					useGenericKey,
				});
				throw new Error("OAI Compatible API key not found");
			}

			// send chat request
			const BASE_URL = baseUrl;
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();

			// prepare headers with custom headers if specified
			const requestHeaders = CommonApi.prepareHeaders(modelApiKey, apiMode, um?.headers);
			logger.debug("request.headers", {
				headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
			});
			logger.debug("request.messages.origin", {
				messages: messages,
			});

			// Context management: honor the context size selected in the VS Code
			// Configure menu. VS Code only reports the selection via
			// `options.modelConfiguration.contextSize` — it never trims history,
			// so we compact here when the history exceeds the budget.
			const contextManagement = config.get<string>("libiaoCopilot.contextManagement", "summarize");
			const contextManagementMode: ContextManagementMode =
				contextManagement === "off" ? "off" : "summarize";

			// Stateful Responses requests resume server-side state, so the gateway
			// keeps the full history and any client-side compaction would be
			// discarded (Copilot Chat likewise relies on server-side truncation
			// there). Skip compaction when the `previous_response_id` path will be
			// used. If the gateway rejects the stateful request, the fallback
			// sends the full history once — and from the next request on,
			// compaction applies again because the base URL is marked unsupported.
			const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
			// 状态标记里的 modelId 必须用完整的 `model.id`：宿主回灌历史时会用
			// `languageModel.id` 重新编码 marker（`id::configId` 形式），若这里拿
			// `parsedModelId.baseId` 比对，带 configId 的组合模型将永远匹配不上。
			const statefulMarker =
				apiMode === "openai-responses"
					? findLastOpenAIResponsesStatefulMarker(model.id, messages)
					: null;
			const willUsePreviousResponseId =
				statefulMarker !== null &&
				statefulMarker.index >= 0 &&
				statefulMarker.index < messages.length - 1 &&
				!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl);

			let effectiveMessages = messages;
			if (!willUsePreviousResponseId) {
				const managed = await manageContext(messages, options, {
					apiMode,
					baseUrl: BASE_URL,
					modelId: parsedModelId.baseId,
					apiKey: modelApiKey,
					headers: requestHeaders as Record<string, string>,
					retryConfig,
					modelConfig,
					mode: contextManagementMode,
					summarizationInstructions: config.get<string>("libiaoCopilot.summarizationInstructions", ""),
					summarizeMaxTokens: config.get<number>("libiaoCopilot.summarizeMaxTokens", 4000),
					token,
				});
				effectiveMessages = managed.messages;
			}
			if (effectiveMessages.length !== messages.length) {
				logger.debug("request.messages.managed", {
					modelId: model.id,
					beforeCount: messages.length,
					afterCount: effectiveMessages.length,
				});
			}
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi(model.id);
				currentApi = ollamaApi;
				const ollamaMessages = ollamaApi.convertMessages(effectiveMessages, modelConfig);

				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaMessages,
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);

				// send Ollama chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
				logger.debug("request.body", {
					url: url,
					requestBody: summarizeRequestBodyForLog(ollamaRequestBody),
				});
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(ollamaRequestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw withRetryAfter(
							new Error(
								`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							),
							res
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Ollama API");
				}
				await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi(
					model.id,
					um?.cache_control !== false,
					modelConfig.includeEncryptedThinking === true
				);
				currentApi = anthropicApi;
				const anthropicMessages = anthropicApi.convertMessages(effectiveMessages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

				// send Anthropic chat request with retry
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				// The base URL carries the API version prefix (e.g.
				// https://api.anthropic.com/v1); we append the Messages endpoint.
				const url = `${normalizedBaseUrl}/messages`;
				logger.debug("request.body", { url, requestBody: summarizeRequestBodyForLog(requestBody) });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw withRetryAfter(
							new Error(
								`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							),
							res
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode
				const openaiResponsesApi = new OpenaiResponsesApi(model.id);
				currentApi = openaiResponsesApi;
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				// 与上面的查找保持一致：marker 载荷里写的必须是完整 model.id。
				const statefulModelId = model.id;

				// Convert full history once (also extracts system `instructions`).
				const fullInput = openaiResponsesApi.convertMessages(effectiveMessages, modelConfig);

				const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, effectiveMessages);
				let deltaInput: unknown[] | null = null;
				if (marker && marker.index >= 0 && marker.index < effectiveMessages.length - 1) {
					const deltaMessages = effectiveMessages.slice(marker.index + 1);
					const converted = openaiResponsesApi.convertMessages(deltaMessages, modelConfig);
					if (converted.length > 0) {
						deltaInput = converted;
					}
				}

				const canUsePreviousResponseId =
					!!marker?.marker &&
					!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl) &&
					Array.isArray(deltaInput) &&
					deltaInput.length > 0;

				const input = canUsePreviousResponseId ? deltaInput! : fullInput;

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input,
					stream: true,
				};

				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

				// Add prompt_cache_key to enable OpenAI prompt caching.
				// Without this parameter, cached_tokens is always 0 even with identical requests.
				if (!requestBody.prompt_cache_key) {
					requestBody.prompt_cache_key = `oaicopilot-${parsedModelId.baseId}`;
				}
				// send Responses API request with retry
				const url = `${normalizedBaseUrl}/responses`;
				logger.debug("request.body", { url, requestBody: summarizeRequestBodyForLog(requestBody) });

				// If the user explicitly set `previous_response_id` via `extra`, don't apply stateful slicing.
				let addedPreviousResponseId = false;
				if (requestBody.previous_response_id !== undefined) {
					requestBody.input = fullInput;
				} else if (canUsePreviousResponseId) {
					requestBody.previous_response_id = marker!.marker;
					addedPreviousResponseId = true;
				}

				const sendRequest = async (body: Record<string, unknown>) =>
					await executeWithRetry(async () => {
						const res = await fetch(url, {
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(body),
						});

						if (!res.ok) {
							const errorText = await res.text();
							const error = new Error(
								`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							);
							(error as { status?: number; errorText?: string }).status = res.status;
							(error as { status?: number; errorText?: string }).errorText = errorText;
							throw withRetryAfter(error, res);
						}

						return res;
					}, retryConfig);

				let response: Response;
				try {
					response = await sendRequest(requestBody);
				} catch (err) {
					// Some Responses-compatible gateways don't support `previous_response_id`.
					// Fall back to sending full history when the previous-response attempt fails.
					const status = (err as { status?: unknown })?.status;
					const shouldFallback =
						addedPreviousResponseId && typeof status === "number" && status >= 400 && status < 500 && status !== 429;
					if (!shouldFallback) {
						throw err;
					}

					this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.add(normalizedBaseUrl);

					let fallbackBody: Record<string, unknown> = {
						model: parsedModelId.baseId,
						input: fullInput,
						stream: true,
					};
					fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, um, options);
					delete fallbackBody.previous_response_id;
					response = await sendRequest(fallbackBody);
				}

				if (!response.body) {
					throw new Error("No response body from Responses API");
				}
				await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);

				// Append a stateful marker so future requests can reuse `previous_response_id` (Copilot Chat style).
				const responseId = openaiResponsesApi.responseId;
				if (responseId) {
					trackingProgress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
				}
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(model.id, this._geminiToolCallMetaByCallId);
				currentApi = geminiApi;
				const geminiMessages = geminiApi.convertMessages(effectiveMessages, modelConfig);

				const systemParts: string[] = [];
				const contents: GeminiGenerateContentRequest["contents"] = [];
				for (const msg of geminiMessages) {
					if (msg.role === "system") {
						const text = msg.parts
							.map((p) =>
								p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
									? String((p as { text: string }).text)
									: ""
							)
							.join("")
							.trim();
						if (text) {
							systemParts.push(text);
						}
						continue;
					}
					contents.push({ role: msg.role, parts: msg.parts });
				}

				let requestBody: GeminiGenerateContentRequest = {
					contents,
				};
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				logger.debug("request.body", { url, requestBody: summarizeRequestBodyForLog(requestBody) });
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}

				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Gemini Provider] Gemini API error response", errorText);
						throw withRetryAfter(
							new Error(
								`Gemini API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							),
							res
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Gemini API");
				}
				await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi(model.id);
				currentApi = openaiApi;
				const openaiMessages = openaiApi.convertMessages(effectiveMessages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

				// send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				logger.debug("request.body", { url, requestBody: summarizeRequestBodyForLog(requestBody) });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] OAI Compatible API error response", errorText);
						throw withRetryAfter(
							new Error(
								`OAI Compatible API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							),
							res
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from OAI Compatible API");
				}
				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
			}
		} catch (err) {
			console.error("[OAI Compatible Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			// 429 交给宿主按 `retryAfter` 退避；旧版宿主没有 RateLimited 时原样抛出。
			throw asRateLimitedError(err);
		} finally {
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			// 会话统计：读取服务端 usage（可能为空），记录本次请求的 token 数与流式耗时
			// 仅对 Gemini 模型：由于 Gemini 存在静默思考/思考摘要机制，流式耗时取纯正文耗时（textFirstMs -> textLastMs）；
			// 其余模型（OpenAI, Anthropic 等）保持原有的首末 delta 流式耗时（streamFirstMs -> streamLastMs）。
			const usage = currentApi?.getUsage() ?? null;
			const isGemini = actualApiMode === "gemini";
			const streamMs =
				isGemini && textFirstMs !== null && textLastMs !== null
					? textLastMs - textFirstMs
					: streamFirstMs !== null && streamLastMs !== null
						? streamLastMs - streamFirstMs
						: 0;
			if (streamMs > 0) {
				// model.id = 组合 ID（id::configId）作统计键；model.name = displayName（带视觉图标）作显示名
				this._sessionStats.recordRequest(model.id, usage, streamMs, model.name, actualApiMode);
			} else {
				logger.debug("sessionStats.skip", { modelId: model.id, reason: "no_delta" });
			}
			// 刷新状态栏 tooltip：会话统计已更新（token 段不变、统计段刷新）
			try {
				await updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig, this._sessionStats, getConfiguredContextSize(options));
			} catch (e) {
				logger.warn("statusBar.update", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param useGenericKey If true, use generic API key.
	 * @param provider Optional provider name to get provider-specific API key.
	 */
	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		// Try to get provider-specific API key first
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const providerKey = `libiaoCopilot.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `OAI Compatible API Key for ${normalizedProvider}`,
					prompt: `Enter your OAI Compatible API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		// Fall back to generic API key
		if (!apiKey) {
			apiKey = await this.secrets.get("libiaoCopilot.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "OAI Compatible API Key",
				prompt: "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("libiaoCopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}
}

interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

function createOpenAIResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
}

function parseOpenAIResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const sep = decoded.indexOf("\\");
		if (sep <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, sep).trim();
		const marker = decoded.slice(sep + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastOpenAIResponsesStatefulMarker(
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[]
): OpenAIResponsesStatefulMarkerLocation | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseOpenAIResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index: i };
			}
		}
	}
	return null;
}
