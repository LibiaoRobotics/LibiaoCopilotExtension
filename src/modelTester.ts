import * as vscode from "vscode";
import type { HFApiMode, HFModelItem, TokenUsage } from "./types";
import { CommonApi } from "./commonApi";
import {
	buildEndpointGroups,
	formatModelDisplayName,
	mergeConfiguredModelWithProviders,
	resolveGroupApiKey,
	type VisionIcon,
} from "./provideModel";
// 各 API 类：测试请求体必须与真实请求走同一套参数化逻辑（prepareRequestBody）
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { OllamaApi } from "./ollama/ollamaApi";
import { GeminiApi, buildGeminiGenerateContentUrl } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import type { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import type { OllamaRequestBody } from "./ollama/ollamaTypes";
import { getBuiltInModel, normalizeUserModels } from "./utils";
import { logger } from "./logger";

/**
 * 模型速度测试器：对「合并验证后的有效模型列表」逐个发起最小化流式请求，
 * 实测生成速度（TPS = 输出 token 数 / 生成耗时）。
 *
 * 设计要点：
 * - 有效列表 = mergeConfiguredModelWithProviders 的结果（与模型选择器完全一致），
 *   未验证的配置模型不会被测试。
 * - 每个模型只发一次请求，输出目标约 300 tokens（max_tokens 限制 4096），
 *   300 tokens 足够测出稳定的 TPS，且总耗时可控（避免长输出压到 60s 超时边缘）。
 * - TTFT（首 token 时间）从首个流式事件开始计 —— 包含思考。
 * - TPS = 输出 token 数 / 生成耗时（总耗时 − TTFT）。
 * - 并发执行（默认 3 路）：不限并发容易触发网关限流导致假失败，
 *   3 路并发在速度与网关压力之间取平衡，需要更快可调大。
 */

/** max_tokens 上限：提示词已限定 ~300，留足余量（代码格式膨胀/标点差异），避免截断 */
const MAX_OUTPUT_TOKENS = 4096;
/** 单个模型测试超时（毫秒）：300 tokens 正常 5-25s 内完成，慢网关/挂死会被强杀 */
const TEST_TIMEOUT_MS = 60_000;
/** 单次读取超时（毫秒），防止流挂死 */
const STREAM_READ_TIMEOUT_MS = 30_000;
/** 默认并发度（可通过 runModelTests 的 concurrency 参数覆盖） */
const DEFAULT_TEST_CONCURRENCY = 3;

/** 测试请求用的固定 prompt：明确告知这是 TPS 性能测试并禁止思考（避免思考吃光预算导致 TPS 测不出来），要求输出固定长度便于统计 */ 
const TEST_PROMPT = "这是一次tps吞吐量测试，直接输出300Token左右的代码";

export interface ModelTestResult {
	/** 模型标识（含 configId，与选择器一致） */
	modelId: string;
	/** 格式化显示名（带视觉图标；前端渲染优先，缺失时回退 modelId） */
	name?: string;
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
 * 构造测试请求 body。
 *
 * 设计原则（根治“自造格式”漂移）：
 * - 只搭各协议的最小基体（单 user 消息、流式、测试专用 prompt）；
 * - 具体参数化（reasoning_effort / temperature / extra / max_tokens 等）
 *   全部交给各 API 类的真实 prepareRequestBody —— 与真实请求同源，
 *   网关升级或参数变化时自动同步，不会再出现测试与真实不一致。
 * - 覆盖 max_tokens 为测试值（真实配置可能是 128000+，测试只需 ~1100）。
 * @internal 仅测试用途导出
 */
export function buildTestRequestBody(model: HFModelItem, apiMode: HFApiMode | string): Record<string, unknown> {
	// 用测试值覆盖 max_tokens：真实配置的 max_tokens（128000/384000）与测试目标（1100）冲突
	// 同时强制 effort=low：测 TPS 的意图是「量吞吐/可用性」，不是测思考深度；
	// 深思考（deepseek-v4-pro 的 max 档实测思考可达 2500+ 字符）会吃光 max_tokens 预算，
	// 正文 0 字符 + 流以 incomplete 结束（无 usage）→ 测试误判失败。
	const testModel: HFModelItem = {
		...model,
		max_tokens: MAX_OUTPUT_TOKENS,
		max_completion_tokens: undefined,
		reasoning_effort: "low",
		// anthropic 模式（glm 系列）：extra.thinking 原样透传（budget_tokens: 32000 会吃光
		// max_tokens 预算导致正文 0/超时）。测试时压到 Anthropic 官方最低档 1024——
		// 保留思考（不关闭），只是预算最小。
		extra:
			model.extra && typeof model.extra === "object" &&
			(model.extra as Record<string, unknown>).thinking &&
			typeof (model.extra as Record<string, unknown>).thinking === "object"
				? {
						...model.extra,
						thinking: {
							...(model.extra as Record<string, unknown>).thinking as Record<string, unknown>,
							budget_tokens: 1024,
						},
					}
				: model.extra,
	};

	switch (apiMode) {
		case "anthropic": {
			// 最小基体：Anthropic 必填 max_tokens（prepareRequestBody 会用测试值覆盖）
			const body: AnthropicRequestBody = {
				model: model.id,
				messages: [{ role: "user", content: TEST_PROMPT }],
				stream: true,
				max_tokens: MAX_OUTPUT_TOKENS,
			};
			return new AnthropicApi(model.id).prepareRequestBody(body, testModel, undefined) as unknown as Record<
				string,
				unknown
			>;
		}
		case "ollama": {
			const body: OllamaRequestBody = {
				model: model.id,
				messages: [{ role: "user", content: TEST_PROMPT }],
				stream: true,
			};
			return new OllamaApi(model.id).prepareRequestBody(body, testModel, undefined) as unknown as Record<
				string,
				unknown
			>;
		}
		case "gemini": {
			// 与 provider.ts 真实请求一致：流式由 URL 参数控制，body 不需要 stream 字段
			const body: GeminiGenerateContentRequest = {
				contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
			};
			return new GeminiApi(model.id).prepareRequestBody(body, testModel, undefined) as unknown as Record<
				string,
				unknown
			>;
		}
		case "openai-responses": {
			// input 必须是标准数组格式（含 type/id/status）—— 网关（如 new-api）不兼容纯字符串
			const body: Record<string, unknown> = {
				model: model.id,
				// 双保险：qwen 认顶层 reasoning_effort，deepseek 认嵌套 reasoning.effort，
				// 两个都发（实测 new-api 网关两者兼容，各取所需）
				reasoning_effort: "low",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: TEST_PROMPT }],
						type: "message",
						id: `msg_test_${Date.now()}`,
						status: "completed",
					},
				],
				stream: true,
			};
			return new OpenaiResponsesApi(model.id).prepareRequestBody(body, testModel, undefined);
		}
		default: {
			// openai（及兜底）：与 provider.ts 真实请求一致
			const body: Record<string, unknown> = {
				model: model.id,
				messages: [{ role: "user", content: TEST_PROMPT }],
				stream: true,
				stream_options: { include_usage: true },
			};
			return new OpenaiApi(model.id).prepareRequestBody(body, testModel, undefined);
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
		const thoughts = toNumber(um.thoughtsTokenCount);
		const candidates = toNumber(um.candidatesTokenCount);
		const completionTokens = candidates + thoughts;
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
 * 加载「有效模型列表」的测试标识（含 configId）。
 * 与 runModelTests 内部使用同一份验证逻辑（mergeConfiguredModelWithProviders），
 * 保证「界面上看到的 = 实际测试的」。
 * 加载失败（网关挂/没 key 等）时 reason 携带原因，供前端展示。
 */
export async function loadTestModelList(secrets: vscode.SecretStorage): Promise<{
	models: TestModelInfo[];
	reason?: string;
}> {
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));
	const configuredModels = userModels.filter((m) => !m.id.startsWith("__provider__"));
	const globalBaseUrl = config.get<string>("libiaoCopilot.baseUrl", "");

	const merged = await mergeConfiguredModelWithProviders({
		secrets,
		configuredModels,
		globalBaseUrl,
	});
	if (merged.models.length === 0) {
		const reason =
			merged.reason?.kind === "fetchFailed"
				? merged.reason.error
				: merged.reason?.kind === "noApiKey"
					? "未配置 API Key"
					: merged.reason?.kind === "invalidBaseUrl"
						? "未配置基础地址"
						: "供应商未返回任何模型";
		return { models: [], reason };
	}
	return { models: merged.models.map((m) => toTestModelInfo(m, readVisionIcon())) };
}

/**
 * 对有效模型列表执行 TPS 测试：
 * 1. 通过 mergeConfiguredModelWithProviders 获取验证后的模型列表（与选择器一致）
 * 2. 通过 onList 一次性回报全部待测模型（前端立即渲染整张表）
 * 3. 以并发度（默认 3）的 worker 池并发执行测试；每个模型开工前回调
 *    onRunning，出结果回调 onResult（前端原地刷新对应行）
 * modelIds 可选：仅测试其中指定的模型（黑名单过滤后勾选的子集）。
 */
export async function runModelTests(options: {
	secrets: vscode.SecretStorage;
	/** 列表就绪后一次性回报全部待测模型（id + 显示名） */
	onList?: (models: TestModelInfo[]) => void;
	/** 单个模型开始测试时回调 */
	onRunning?: (modelId: string) => void;
	onResult: (result: ModelTestResult) => void;
	token?: vscode.CancellationToken;
	/** 并发度（默认 3；调大会更快，但更容易触发网关限流） */
	concurrency?: number;
	/** 仅测试这些模型 id（黑名单过滤后勾选子集）；缺省测全部 */
	modelIds?: string[];
}): Promise<{ tested: number; succeeded: number }> {
	const { secrets, onList, onRunning, onResult, token } = options;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_TEST_CONCURRENCY);
	const icon = readVisionIcon();
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
	const allModels = merged.models;
	// 黑名单过滤：只测勾选子集；缺省测全部
	const selectedSet = options.modelIds ? new Set(options.modelIds) : undefined;
	const models = selectedSet ? allModels.filter((m) => selectedSet.has(toTestModelId(m))) : allModels;
	// 一次性回报本次实际要测的模型（过滤后），前端渲染的行数 = 进度分母
	onList?.(models.map((m) => toTestModelInfo(m, icon)));
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

	// merged 模型可能包含 group 没有（如 discovered），此时回退全局/模型级 key
	const globalApiKey = await secrets.get("libiaoCopilot.apiKey");
	const plans = await Promise.all(
		models.map(async (model): Promise<TestPlan> => {
			const baseUrl = model.baseUrl || globalBaseUrl;
			const apiMode = (model.apiMode ?? "openai") as HFApiMode | string;
			const groupInfo = groupKeyMap.get(`${apiMode}|${baseUrl}`);
			const apiKey =
				groupInfo?.apiKey ??
				// 回退：该模型不在已验证组内（极少见），用模型级 provider key 或全局 key
				(await getModelApiKey(model, secrets)) ??
				globalApiKey;
			return { model, apiMode, baseUrl, apiKey };
		})
	);

	const overrideSource = token ? null : new vscode.CancellationTokenSource();
	const effectiveToken = token ?? overrideSource!.token;

	let tested = 0;
	let succeeded = 0;

	try {
		// 并发游标：每个 worker 取号执行，天然均匀分发任务
		let cursor = 0;
		const workerCount = Math.min(concurrency, plans.length);
		const worker = async () => {
			while (!effectiveToken.isCancellationRequested) {
				const i = cursor++;
				if (i >= plans.length) {
					break;
				}
				const plan = plans[i];
				const modelId = toTestModelId(plan.model);
				if (!plan.apiKey) {
					onResult({
						modelId,
						name: toTestModelName(plan.model, icon),
						ok: false,
						error: "未找到该模型的 API Key（请先在配置中为供应商设置 API Key）",
					});
					tested++;
					continue;
				}
				onRunning?.(modelId);
				const result = await testSingleModel(plan.model, plan.apiKey, plan.apiMode, plan.baseUrl, effectiveToken);
				if (effectiveToken.isCancellationRequested) {
					// 用户已取消：结果不再回报（前端会显示"已取消"），但计入已测
					tested++;
					break;
				}
				onResult({ ...result, name: toTestModelName(plan.model, icon) });
				tested++;
				if (result.ok) {
					succeeded++;
				}
			}
		};
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
	} finally {
		overrideSource?.dispose();
	}

	return { tested, succeeded };
}

/** 模型的测试标识（含 configId，与选择器一致） */
export function toTestModelId(model: HFModelItem): string {
	return model.configId ? `${model.id}::${model.configId}` : model.id;
}

/** 待测模型的基础信息（列表与结果行共用）：id 定位行、name 展示 */
export interface TestModelInfo {
	/** 模型组合 ID（id::configId，与选择器一致） */
	id: string;
	/** 格式化显示名（displayName 优先、内置表兜底、vision 驱动图标；兜底 id） */
	name: string;
}

/** 模型显示名：与模型选择器用同一套规则（displayName → 内置表 → 组合 ID，vision 驱动图标） */
export function toTestModelName(model: HFModelItem, icon: VisionIcon = "picture"): string {
	const builtIn = getBuiltInModel(model.id);
	const vision = model.vision ?? builtIn?.vision ?? false;
	return formatModelDisplayName(
		model.displayName || builtIn?.displayName || toTestModelId(model),
		vision,
		icon
	);
}

function toTestModelInfo(model: HFModelItem, icon: VisionIcon): TestModelInfo {
	return { id: toTestModelId(model), name: toTestModelName(model, icon) };
}

/** 读取视觉图标配置（picture 默认 / eye） */
function readVisionIcon(): VisionIcon {
	const v = vscode.workspace.getConfiguration().get<string>("libiaoCopilot.visionIcon", "picture");
	return v === "picture" ? "picture" : "eye";
}

/** 单个模型的测试计划（列表就绪后预先解析好，并发执行时直接用） */
interface TestPlan {
	model: HFModelItem;
	apiMode: HFApiMode | string;
	baseUrl: string;
	apiKey: string | undefined;
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
