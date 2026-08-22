import * as vscode from "vscode";
import type { HFApiMode, HFModelItem, TokenUsage } from "./types";
import { CommonApi } from "./commonApi";
import { buildEndpointGroups, mergeConfiguredModelWithProviders, resolveGroupApiKey } from "./provideModel";
import { buildGeminiGenerateContentUrl } from "./gemini/geminiApi";
import { normalizeUserModels } from "./utils";
import { logger } from "./logger";

/**
 * 模型速度测试器：对「合并验证后的有效模型列表」逐个发起最小化流式请求，
 * 实测生成速度（TPS = 输出 token 数 / 生成耗时）。
 *
 * 设计要点：
 * - 有效列表 = mergeConfiguredModelWithProviders 的结果（与模型选择器完全一致），
 *   未验证的配置模型不会被测试。
 * - 每个模型只发一次请求，输出目标约 1000 tokens（max_tokens 限制 1100），
 *   低 token 数测试 TPS 波动大、不够准；1000 tokens 兼顾准确与成本。
 * - TTFT（首 token 时间）从首个流式事件开始计 —— 包含思考。
 * - TPS = 输出 token 数 / 生成耗时（总耗时 − TTFT）。
 * - 串行执行，避免网关并发限流。
 */

/** 测试输出目标 token 数 */
const TARGET_OUTPUT_TOKENS = 1000;
/** max_tokens 上限（目标 + 余量 100，避免截断） */
const MAX_OUTPUT_TOKENS = TARGET_OUTPUT_TOKENS + 100;
/** 单个模型测试超时（毫秒）：1000 tokens 正常 30-60s 内完成，慢网关/挂死会被强杀 */
const TEST_TIMEOUT_MS = 60_000;
/** 单次读取超时（毫秒），防止流挂死 */
const STREAM_READ_TIMEOUT_MS = 30_000;

/** 测试请求用的固定 prompt：让模型输出约 1000 tokens 的纯文本 */
const TEST_PROMPT =
	"请写一篇关于人工智能发展的科普短文，大约 1000 个汉字，直接输出正文，不要任何开头说明或结尾总结。";

export interface ModelTestResult {
	/** 模型标识（含 configId，与选择器一致） */
	modelId: string;
	/** 测试是否成功 */
	ok: boolean;
	/** 首 token 时间（毫秒，从请求发出到首个流式事件，含思考） */
	ttftMs?: number;
	/** 总耗时（毫秒，含思考/网络） */
	totalMs?: number;
	/** 生成阶段耗时（毫秒，总耗时 − TTFT） */
	generateMs?: number;
	/** 输出 token 数（优先 usage，透传失败按估算） */
	outputTokens?: number;
	/** TPS = 输出 token 数 / 生成耗时 */
	tps?: number;
	/** 错误信息 */
	error?: string;
}

/** 单个模型的测试中间状态 */
interface TestState {
	/** 请求发出时刻（TTFT 基准） */
	requestStart: number;
	/** 首个流式事件时刻（含思考） */
	firstEventAt: number | null;
	/** 输出内容累计字符数（估算兜底用） */
	outputChars: number;
	/** 最近一次成功读取时刻（检测流挂死，保留备用） */
	lastReadAt: number;
}

/**
 * 测试一个模型：发最小化流式请求并统计指标。
 * @internal 仅测试用途导出
 */
export async function testSingleModel(
	model: HFModelItem,
	apiKey: string,
	apiMode: HFApiMode | string,
	baseUrl: string,
	token: vscode.CancellationToken
): Promise<ModelTestResult> {
	const modelId = model.configId ? `${model.id}::${model.configId}` : model.id;

	// TTFT 基准：请求发出时刻（fetch 之前）
	const state: TestState = {
		requestStart: Date.now(),
		firstEventAt: null,
		outputChars: 0,
		lastReadAt: Date.now(),
	};

	// 取消 + 超时都 abort 同一个 controller，fetch 与流读取一并中断
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	// 保存 Disposable，finally 里释放（防止监听器泄漏）
	const cancelSub = token.onCancellationRequested(onAbort, undefined, []);
	// 单模型总超时（60s）
	const timeoutTimer = setTimeout(onAbort, TEST_TIMEOUT_MS);

	try {
		const headers = CommonApi.prepareHeaders(apiKey, apiMode, model.headers);
		const url = buildTestUrl(baseUrl, apiMode, model.id);
		const body = buildTestRequestBody(model, apiMode);
		logger.info("modelTest.request", { modelId, url });

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			return buildResult(modelId, state, {
				ok: false,
				error: `[${response.status}] ${response.statusText}${errorText ? ` ${errorText.slice(0, 200)}` : ""}`,
			});
		}
		if (!response.body) {
			return buildResult(modelId, state, { ok: false, error: "响应没有 body 流" });
		}

		const usage = await consumeStream(response.body, state, token);
		return buildResult(modelId, state, { ok: true, usage });
	} catch (error) {
		const aborted = controller.signal.aborted;
		const timedOut = !controller.signal.aborted && Date.now() - state.requestStart > TEST_TIMEOUT_MS;
		return buildResult(modelId, state, {
			ok: false,
			error: aborted
				? "已取消或超时"
				: timedOut
					? "测试超时（60s）"
					: error instanceof Error
						? error.message
						: String(error),
		});
	} finally {
		clearTimeout(timeoutTimer);
		cancelSub.dispose();
		controller.abort(); // 无论成功失败，都中断读取
	}
}

/**
 * 组装模型测试结果。
 * @internal 仅测试用途导出
 */
export function buildResult(
	modelId: string,
	state: TestState,
	info: { ok: true; usage: TokenUsage | undefined } | { ok: false; error: string }
): ModelTestResult {
	const totalMs = Date.now() - state.requestStart;
	const ttftMs = state.firstEventAt === null ? null : state.firstEventAt - state.requestStart;
	if (info.ok) {
		if (ttftMs === null) {
			return { modelId, ok: false, error: "流未返回任何内容" };
		}
		const generateMs = Math.max(1, totalMs - ttftMs);
		const outputTokens = info.usage?.completion_tokens ?? estimateTokens(state.outputChars);
		// 0 token 边界：usage 为 0 或字符估算为 0（异常流），标记失败避免 TPS=0 误导
		if (!outputTokens || outputTokens < 1) {
			return { modelId, ok: false, error: "流未返回可计数的输出 token（可能被截断或模型输出为空）" };
		}
		return {
			modelId,
			ok: true,
			ttftMs,
			totalMs,
			generateMs,
			outputTokens,
			tps: Math.round((outputTokens / generateMs) * 1000 * 10) / 10,
		};
	}
	return {
		modelId,
		ok: false,
		error: info.error,
		...(ttftMs !== null ? { ttftMs, totalMs } : {}),
	};
}

/**
 * 构造测试请求 URL（与 provider.ts 真实路径一致）。
 * @internal 仅测试用途导出
 */
export function buildTestUrl(baseUrl: string, apiMode: HFApiMode | string, modelId: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	switch (apiMode) {
		case "anthropic":
			return `${normalized}/messages`;
		case "ollama":
			return `${normalized}/api/chat`;
		case "gemini": {
			// gemini 的 URL 组装逻辑在 geminiApi.ts（含 v1beta 前缀处理）
			const url = buildGeminiGenerateContentUrl(normalized, modelId, true);
			if (!url) {
				throw new Error("Gemini base URL 无效或模型路径无法解析");
			}
			return url;
		}
		case "openai-responses":
			return `${normalized}/responses`;
		default:
			return `${normalized}/chat/completions`;
	}
}

/**
 * 构造测试请求 body（与 provider.ts 各 apiMode 的真实请求体对齐）。
 * @internal 仅测试用途导出
 */
export function buildTestRequestBody(model: HFModelItem, apiMode: HFApiMode | string): Record<string, unknown> {
	switch (apiMode) {
		case "anthropic": {
			const body: Record<string, unknown> = {
				model: model.id,
				messages: [
					{
						role: "user",
						content: TEST_PROMPT,
					},
				],
				stream: true,
				max_tokens: MAX_OUTPUT_TOKENS,
			};
			return body;
		}
		case "ollama": {
			return {
				model: model.id,
				messages: [{ role: "user", content: TEST_PROMPT }],
				stream: true,
				options: { num_predict: MAX_OUTPUT_TOKENS },
			};
		}
		case "gemini": {
			// 与 provider.ts 真实请求体一致：流式由 URL 参数（streamGenerateContent?alt=sse）控制，
			// body 不需要 stream 字段（Gemini API 会忽略未知字段，但保持最小化、与真实路径对齐）
			return {
				contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
				generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
			};
		}
		case "openai-responses": {
			return {
				model: model.id,
				input: TEST_PROMPT,
				stream: true,
				max_output_tokens: MAX_OUTPUT_TOKENS,
			};
		}
		default: {
			return {
				model: model.id,
				messages: [{ role: "user", content: TEST_PROMPT }],
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: MAX_OUTPUT_TOKENS,
			};
		}
	}
}

/**
 * 消费流式响应：
 * - 首个数据块即记录 firstEventAt（TTFT 含思考）
 * - 逐事件提取 usage（优先级高于字符估算）
 * - 累计输出字符（无 usage 时估算兜底）
 * - 30s 无数据判定流挂死，抛错中止
 * @internal 仅测试用途导出
 */
export async function consumeStream(
	body: ReadableStream<Uint8Array>,
	state: TestState,
	token: vscode.CancellationToken
): Promise<TokenUsage | undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: TokenUsage | undefined;

	try {
		while (true) {
			if (token.isCancellationRequested) {
				break;
			}
			// 流挂死保护：30s 无任何数据块则失败
			if (Date.now() - state.lastReadAt > STREAM_READ_TIMEOUT_MS) {
				throw new Error("流读取超时（30s 无数据）");
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			// 首个数据块即 TTFT（含思考）
			if (state.firstEventAt === null) {
				state.firstEventAt = Date.now();
			}
			state.lastReadAt = Date.now();
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				// 兼容 SSE（data: 前缀）与 Ollama 纯 JSON line
				const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
				if (!payload || payload === "[DONE]") {
					continue;
				}
				try {
					const parsed = JSON.parse(payload) as Record<string, unknown>;
					const u = extractUsage(parsed);
					if (u) {
						usage = u;
					}
					state.outputChars += extractDeltaChars(parsed);
				} catch {
					// 忽略无法解析的行
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	return usage;
}

/** 从流式 JSON 中提取 token usage（多协议兼容）
 * @internal 仅测试用途导出
 */
export function extractUsage(parsed: Record<string, unknown>): TokenUsage | undefined {
	// ---- OpenAI chat: 顶层 usage（最后一个 chunk）----
	const usageObj = parsed.usage as Record<string, unknown> | undefined;
	if (usageObj && typeof usageObj === "object") {
		const completionTokens = toNumber(usageObj.completion_tokens);
		const promptTokens = toNumber(usageObj.prompt_tokens);
		if (completionTokens > 0 || promptTokens > 0) {
			return {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: toNumber(usageObj.total_tokens) || promptTokens + completionTokens,
			};
		}
	}

	// ---- OpenAI Responses: response.completed 事件的 usage 字段 ----
	if (parsed.type === "response.completed") {
		const resp = parsed.response as Record<string, unknown> | undefined;
		const u = (resp?.usage ?? parsed.usage) as Record<string, unknown> | undefined;
		if (u && typeof u === "object") {
			const completionTokens = toNumber(u.output_tokens ?? u.completion_tokens);
			const promptTokens = toNumber(u.input_tokens ?? u.prompt_tokens);
			if (completionTokens > 0 || promptTokens > 0) {
				return {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: promptTokens + completionTokens,
				};
			}
		}
	}

	// ---- Anthropic: message_delta 事件的 usage 字段（input_tokens/output_tokens）----
	if (parsed.type === "message_delta") {
		const u = parsed.usage as Record<string, unknown> | undefined;
		if (u && typeof u === "object") {
			const completionTokens = toNumber(u.output_tokens);
			const promptTokens =
				toNumber(u.input_tokens) +
				toNumber(u.cache_creation_input_tokens) +
				toNumber(u.cache_read_input_tokens);
			if (completionTokens > 0 || promptTokens > 0) {
				return {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: promptTokens + completionTokens,
				};
			}
		}
	}

	// ---- Gemini: 顶层 usageMetadata ----
	const um = parsed.usageMetadata as Record<string, unknown> | undefined;
	if (um && typeof um === "object") {
		const completionTokens = toNumber(um.candidatesTokenCount);
		const promptTokens = toNumber(um.promptTokenCount);
		if (completionTokens > 0 || promptTokens > 0) {
			return {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: toNumber(um.totalTokenCount) || promptTokens + completionTokens,
			};
		}
	}

	// ---- Ollama: 最后 chunk 的 eval_count / prompt_eval_count ----
	if (parsed.done === true) {
		const completionTokens = toNumber(parsed.eval_count);
		const promptTokens = toNumber(parsed.prompt_eval_count);
		if (completionTokens > 0 || promptTokens > 0) {
			return {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			};
		}
	}

	return undefined;
}

/** 提取当前事件中的输出文本增量字符数（各协议字段不同）
 * @internal 仅测试用途导出
 */
export function extractDeltaChars(parsed: Record<string, unknown>): number {
	let chars = 0;

	// OpenAI chat: delta.content（部分网关用 delta.text）
	// 注意排除 Anthropic content_block_delta：它的 delta.text 在下方专有分支统计，
	// 若在这里也统计会重复计数（Anthropic 实例会翻倍，导致无 usage 时 TPS 误报）
	const delta = parsed.delta as Record<string, unknown> | undefined;
	if (delta && typeof delta === "object" && parsed.type !== "content_block_delta") {
		if (typeof delta.content === "string") {
			chars += delta.content.length;
		} else if (typeof delta.text === "string") {
			chars += delta.text.length;
		}
	}

	// OpenAI Responses: response.output_text.delta 事件的 delta 字符串
	if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
		chars += parsed.delta.length;
	}

	// Anthropic: content_block_delta.delta.text
	if (parsed.type === "content_block_delta") {
		const cbDelta = parsed.delta as Record<string, unknown> | undefined;
		if (cbDelta && typeof cbDelta === "object" && typeof cbDelta.text === "string") {
			chars += cbDelta.text.length;
		}
	}

	// Gemini: candidates[].content.parts[].text
	const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(candidates)) {
		for (const c of candidates) {
			const content = c.content as Record<string, unknown> | undefined;
			const parts = content?.parts as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(parts)) {
				for (const p of parts) {
					if (typeof p.text === "string") {
						chars += p.text.length;
					}
				}
			}
		}
	}

	// Ollama: message.content
	const message = parsed.message as Record<string, unknown> | undefined;
	if (message && typeof message === "object" && typeof message.content === "string") {
		chars += message.content.length;
	}

	return chars;
}

/** 安全转数字（NaN/undefined → 0） */
function toNumber(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** 估算输出 token 数（中英混排粗估：中文 ≈ 0.6 token/字）
 * @internal 仅测试用途导出
 */
export function estimateTokens(chars: number): number {
	if (chars <= 0) {
		return 0;
	}
	return Math.max(1, Math.round(chars * 0.6));
}

/**
 * 对有效模型列表执行 TPS 测试：
 * 1. 通过 mergeConfiguredModelWithProviders 获取验证后的模型列表（与选择器一致）
 * 2. 对每个模型串行执行 testSingleModel
 * 3. 结果逐条通过 onResult 回调（前端实时更新）
 */
export async function runModelTests(options: {
	secrets: vscode.SecretStorage;
	onStart?: (total: number) => void;
	onResult: (result: ModelTestResult) => void;
	token?: vscode.CancellationToken;
}): Promise<{ tested: number; succeeded: number }> {
	const { secrets, onResult, onStart, token } = options;
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));
	const configuredModels = userModels.filter((m) => !m.id.startsWith("__provider__"));
	const globalBaseUrl = config.get<string>("libiaoCopilot.baseUrl", "");

	// 1. 合并验证：拿有效模型列表
	const merged = await mergeConfiguredModelWithProviders({
		secrets,
		configuredModels,
		globalBaseUrl,
	});
	const models = merged.models;
	onStart?.(models.length);
	if (models.length === 0) {
		const reason =
			merged.reason?.kind === "fetchFailed"
				? merged.reason.error
				: merged.reason?.kind === "noApiKey"
					? "未配置 API Key"
					: merged.reason?.kind === "invalidBaseUrl"
						? "未配置基础地址"
						: "供应商未返回任何模型";
		const result: ModelTestResult = {
			modelId: "__empty__",
			ok: false,
			error: reason,
		};
		onResult(result);
		return { tested: 0, succeeded: 0 };
	}

	// 2. 按端点分组，解析每组 key
	const groups = buildEndpointGroups(configuredModels, globalBaseUrl);
	const groupKeyMap = new Map<string, { apiKey: string; apiMode: HFApiMode | string; baseUrl: string }>();
	for (const [key, group] of groups) {
		const apiKey = await resolveGroupApiKey(group, secrets);
		if (apiKey) {
			groupKeyMap.set(key, { apiKey, apiMode: group.apiMode, baseUrl: group.baseUrl });
		}
	}

	const overrideSource = token ? null : new vscode.CancellationTokenSource();
	const effectiveToken = token ?? overrideSource!.token;

	let tested = 0;
	let succeeded = 0;

	try {
		// 模型+端点来源：merged 列表里的模型都来自已验证组，但需要对应组 key。
		// merged 模型可能包含 group 没有（如 discovered），此时回退全局 key。
		const globalApiKey = await secrets.get("libiaoCopilot.apiKey");

		for (const model of models) {
			if (effectiveToken.isCancellationRequested) {
				break;
			}
			const baseUrl = model.baseUrl || globalBaseUrl;
			const apiMode = (model.apiMode ?? "openai") as HFApiMode | string;
			const key = `${apiMode}|${baseUrl}`;
			const groupInfo = groupKeyMap.get(key);

			const apiKey =
				groupInfo?.apiKey ??
				// 回退：该模型不在已验证组内（极少见），用模型级 provider key 或全局 key
				(await getModelApiKey(model, secrets)) ??
				globalApiKey;

			if (!apiKey) {
				onResult({
					modelId: model.configId ? `${model.id}::${model.configId}` : model.id,
					ok: false,
					error: "未找到该模型的 API Key（请先在配置中为供应商设置 API Key）",
				});
				tested++;
				continue;
			}

			const result = await testSingleModel(model, apiKey, apiMode, baseUrl, effectiveToken);
			onResult(result);
			tested++;
			if (result.ok) {
				succeeded++;
			}
			if (effectiveToken.isCancellationRequested) {
				break;
			}
		}
	} finally {
		overrideSource?.dispose();
	}

	return { tested, succeeded };
}

/** 模型级 API key 解析（provider 专属 key → 全局 key） */
async function getModelApiKey(model: HFModelItem, secrets: vscode.SecretStorage): Promise<string | undefined> {
	const provider = model.owned_by?.toLowerCase().trim();
	if (provider) {
		const key = await secrets.get(`libiaoCopilot.apiKey.${provider}`);
		if (key) {
			return key;
		}
	}
	return undefined;
}
