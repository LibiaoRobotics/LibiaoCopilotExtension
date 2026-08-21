import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation } from "vscode";

import type { HFApiMode, HFModelItem, HFModelsResponse } from "./types";
import {
	createModelConfigurationSchema,
	type ModelPickerChatInformation,
} from "./modelConfiguration";
import { getBuiltInModel, normalizeUserModels } from "./utils";
import { VersionManager } from "./versionManager";
import { fetchGeminiModels } from "./gemini/geminiApi";
import { fetchOllamaModels } from "./ollama/ollamaApi";
import { logger } from "./logger";

const DEFAULT_CONTEXT_LENGTH = 256000;
const DEFAULT_MAX_TOKENS = 4096;
const EXTENSION_LABEL = "Libiao Copilot";

/** 视觉模型图标前缀（U+1F5BC U+FE0F，码点转义写入避免编码问题） */
const VISION_EMOJI = "\u{1F5BC}\uFE0F";

/**
 * 为模型显示名添加视觉图标前缀，由 vision 字段驱动（displayName 不再手工维护 emoji）。
 * 已带前缀时不重复添加，兼容存量配置中已含 emoji 的 displayName。
 */
function formatModelDisplayName(name: string, vision?: boolean): string {
	if (vision && !name.startsWith(VISION_EMOJI)) {
		return VISION_EMOJI + name;
	}
	return name;
}

/**
 * Model id of the placeholder entry shown when no model could be verified
 * (missing/wrong base URL or API key, network error). VS Code hides the
 * whole provider section when an empty list is returned, so a single
 * non-selectable entry keeps the "Libiao Copilot" section visible together
 * with the reason.
 */
export const NO_MODELS_PLACEHOLDER_ID = "__libiao-no-models__";

/** Why no group could be queried against its provider. */
export type NoModelsReason =
	| { kind: "noApiKey" }
	| { kind: "invalidBaseUrl" }
	| { kind: "fetchFailed"; error: string }
	| { kind: "emptyListing" };

/**
 * TTL cache for provider model listings, keyed by `${apiMode}|${baseUrl}`.
 * VS Code invokes model discovery frequently (activation, picker open,
 * config changes, periodic refresh); the cache avoids hitting the provider
 * on every call. When a refresh fails, a stale entry is served so the
 * picker never goes empty during a provider outage.
 */
interface ModelListCacheEntry {
	models: HFModelItem[];
	fetchedAt: number;
}

const modelListCache = new Map<string, ModelListCacheEntry>();

/** Clear all cached model lists (e.g. when configuration or keys change). */
export function clearModelListCache(): void {
	modelListCache.clear();
}

function getModelCacheTtlMs(): number {
	const minutes = vscode.workspace.getConfiguration().get<number>("libiaoCopilot.modelCacheTtlMinutes", 10);
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Fetch models with TTL caching. Returns cached results while fresh; on a
 * failed refresh, falls back to the stale entry when one exists.
 */
async function fetchModelsCached(
	baseUrl: string,
	apiKey: string,
	apiMode?: HFApiMode | string
): Promise<{ models: HFModelItem[]; fromCache: boolean }> {
	const key = `${apiMode ?? "openai"}|${baseUrl}`;
	const ttlMs = getModelCacheTtlMs();
	const entry = modelListCache.get(key);

	if (ttlMs > 0 && entry && Date.now() - entry.fetchedAt < ttlMs) {
		return { models: entry.models, fromCache: true };
	}

	try {
		const { models } = await fetchModels(baseUrl, apiKey, apiMode);
		if (ttlMs > 0) {
			modelListCache.set(key, { models, fetchedAt: Date.now() });
		} else {
			modelListCache.delete(key);
		}
		return { models, fromCache: false };
	} catch (error) {
		if (entry) {
			logger.warn("models.cache.staleFallback", {
				baseUrl,
				error: error instanceof Error ? error.message : String(error),
			});
			return { models: entry.models, fromCache: true };
		}
		throw error;
	}
}

/**
 * Get the list of available language models contributed by this provider
 * @param options Options which specify the calling context of this function
 * @param token A cancellation token which signals if the user cancelled the request or not
 * @returns A promise that resolves to the list of available language models
 */
export async function prepareLanguageModelChatInformation(
	options: { silent: boolean },
	_token: CancellationToken,
	secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
	// Check for user-configured models first
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));
	const configuredModels = userModels.filter((m) => !m.id.startsWith("__provider__"));

	let infos: ModelPickerChatInformation[];
	let source: string;
	if (configuredModels.length > 0) {
		// Merge mode: configured models act as a metadata layer on top of the
		// provider's live model list. Configured models missing from the provider
		// are dropped, while provider models without configuration are exposed
		// with default metadata so newly published models appear automatically.
		// Groups whose endpoint cannot be queried (missing URL/key, or a failed
		// fetch) are hidden; see mergeConfiguredModelWithProviders.
		const globalBaseUrl = config.get<string>("libiaoCopilot.baseUrl", "");
		const merged = await mergeConfiguredModelWithProviders({
			secrets,
			configuredModels,
			globalBaseUrl,
		});
		if (merged.models.length === 0) {
			// Nothing verified: show a single non-selectable placeholder so the
			// "Libiao Copilot" section stays visible together with the reason,
			// instead of the picker hiding the provider entirely.
			infos = [createNoModelsPlaceholderInfo(merged.reason)];
			source = "config+api (placeholder)";
		} else {
			infos = merged.models.map(toModelPickerInfo);
			source = "config+api";
		}
	} else {
		// Fallback: Fetch models from API
		source = "api";
		const apiKey = await ensureApiKey(options.silent, secrets);
		if (!apiKey) {
			if (options.silent) {
				return [];
			} else {
				throw new Error("OAI Compatible API key not found");
			}
		}

		const BASE_URL = config.get<string>("libiaoCopilot.baseUrl", "");
		if (!BASE_URL || !BASE_URL.startsWith("http")) {
			// Base URL not configured: do not fetch, stay silent on
			// background calls so the picker simply shows no models.
			if (options.silent) {
				return [];
			}
			throw new Error(`Invalid base URL configuration. Please set "libiaoCopilot.baseUrl" first.`);
		}
		const { models } = await fetchModelsCached(BASE_URL, apiKey);

		// 每个 API 模型先经 toDiscoveredModelItem 合并内置模型元数据
		// （context_length/context_sizes/reasoning_effort 等），再走
		// toModelPickerInfo 生成 configurationSchema —— 与 merge path 对齐，
		// 保证 models 为空时上下文大小/思考深度选择器依然可用。
		infos = models.flatMap((m) => {
			const merged = toDiscoveredModelItem(m);
			const providers = m?.providers ?? [];
			// 修复：vision 以 merged（内置表 + modalities 推断后的权威值）为准，
			// 原实现只看 modalities，网关不返回模态信息但内置表声明 vision 时会误判为 false
			const vision = merged.vision === true;

			// Build entries for all providers that support tool calling
			const toolProviders = providers.filter((p) => p.supports_tools === true);
			const entries: ModelPickerChatInformation[] = [];

			for (const p of toolProviders) {
				// 内置模型元数据为权威源（网关 listing 常低估上下文），
				// provider 的 context_length 仅作内置表缺失时的兜底
				const contextLen = merged.context_length ?? p?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = merged.max_completion_tokens ?? merged.max_tokens ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				const detail = p.provider ? `${p.provider} (${EXTENSION_LABEL})` : EXTENSION_LABEL;
				// API 返回不带 displayName 时，从内置模型表兜底，避免模型列表只显示 id
				const modelName = formatModelDisplayName(
					merged.displayName || m.displayName || getBuiltInModel(m.id)?.displayName || m.id,
					merged.vision
				);
				const configurationSchema = createModelConfigurationSchema(merged);
				entries.push({
					id: `${m.id}:${p.provider}`,
					name: modelName,
					detail: detail,
					tooltip: detail,
					family: m.family ?? EXTENSION_LABEL,
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					isUserSelectable: true,
					...(configurationSchema ? { configurationSchema } : {}),
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation);
			}

			if (entries.length === 0) {
				const base = providers.length > 0 ? providers[0] : null;
				// 内置模型元数据为权威源（网关 listing 常低估上下文），
				// provider 的 context_length 仅作内置表缺失时的兜底
				const contextLen = merged.context_length ?? base?.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = merged.max_completion_tokens ?? merged.max_tokens ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				const configurationSchema = createModelConfigurationSchema(merged);
				entries.push({
					id: `${m.id}`,
					// API 返回不带 displayName 时，从内置模型表兜底，避免模型列表只显示 id
					name: formatModelDisplayName(
						merged.displayName || m.displayName || getBuiltInModel(m.id)?.displayName || m.id,
						merged.vision
					),
					detail: EXTENSION_LABEL,
					tooltip: EXTENSION_LABEL,
					family: m.family ?? EXTENSION_LABEL,
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					isUserSelectable: true,
					...(configurationSchema ? { configurationSchema } : {}),
					capabilities: {
						toolCalling: true,
						// 修复：原来写死 true，改为跟随合并后的权威 vision 值
						imageInput: merged.vision === true,
					},
				} satisfies LanguageModelChatInformation);
			}

			return entries;
		});
	}

	logger.info("models.loaded", { count: infos.length, source });
	return infos;
}

/**
 * Convert a merged/discovered model item into a model picker entry.
 * Exported for direct unit testing (the merge path requires a verifiable
 * endpoint, which the test environment cannot provide).
 */
export function toModelPickerInfo(m: HFModelItem): ModelPickerChatInformation {
	const contextLen = m?.context_length ?? DEFAULT_CONTEXT_LENGTH;
	const maxOutput = m?.max_completion_tokens ?? m?.max_tokens ?? DEFAULT_MAX_TOKENS;
	const maxInput = Math.max(1, contextLen - maxOutput);

	// Use configId when present so each model configuration stays distinct.
	const modelId = m.configId ? `${m.id}::${m.configId}` : m.id;
	// 用户配置缺失 displayName 时，从内置模型表兜底，避免模型列表只显示 id
	// vision 缺失时同样从内置表兜底（merge 路径的用户配置可能没写 vision 字段）
	const vision = m?.vision ?? getBuiltInModel(m.id)?.vision ?? false;
	const modelName = formatModelDisplayName(
		m.displayName || getBuiltInModel(m.id)?.displayName || modelId,
		vision
	);
	const detail = m.owned_by ? `${m.owned_by} (${EXTENSION_LABEL})` : EXTENSION_LABEL;
	const configurationSchema = createModelConfigurationSchema(m);

	return {
		id: modelId,
		name: modelName,
		detail: detail,
		tooltip: detail,
		family: m.family ?? EXTENSION_LABEL,
		version: "1.0.0",
		maxInputTokens: maxInput,
		maxOutputTokens: maxOutput,
		isUserSelectable: true,
		...(configurationSchema ? { configurationSchema } : {}),
		capabilities: {
			toolCalling: true,
			imageInput: vision,
		},
	} satisfies ModelPickerChatInformation;
}

/**
 * Convert a no-models reason into a single concise, user-facing message.
 * The message is shown directly on the placeholder entry, so it must be
 * short and actionable in one line.
 */
function noModelsReasonMessage(reason?: NoModelsReason): string {
	switch (reason?.kind) {
		case "noApiKey":
			return "未配置 API Key，请运行命令「设置 API Key」";
		case "invalidBaseUrl":
			return "未配置基础地址，请先设置 libiaoCopilot.baseUrl";
		case "fetchFailed":
			return fetchFailureMessage(reason.error);
		case "emptyListing":
			return "供应商未返回任何模型";
		default:
			return "暂无可用模型";
	}
}

/**
 * Classify a provider fetch failure: auth errors (401/403) mean the API
 * key lacks permission — only then is the key mentioned. Every other
 * failure (404, connection refused, unknown host, ...) points at the base
 * URL; the two causes are never mixed in a single message.
 */
function fetchFailureMessage(error: string): string {
	if (/\b40[13]\b/.test(error)) {
		return "权限不足（401/403），请检查 API Key";
	}
	if (/\b404\b/.test(error)) {
		return "基础地址错误（404），请检查 libiaoCopilot.baseUrl";
	}
	if (/\b(fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|timeout)\b/i.test(error)) {
		return "无法连接服务端点，请检查 libiaoCopilot.baseUrl";
	}
	return "模型列表查询失败，请检查 libiaoCopilot.baseUrl";
}

/**
 * Build the non-selectable placeholder entry shown when no model could be
 * verified, keeping the provider section visible. The reason is shown
 * directly as the entry text — no hover/click required.
 */
function createNoModelsPlaceholderInfo(reason?: NoModelsReason): ModelPickerChatInformation {
	const message = noModelsReasonMessage(reason);
	return {
		id: NO_MODELS_PLACEHOLDER_ID,
		name: message,
		tooltip: message,
		family: EXTENSION_LABEL,
		version: "1.0.0",
		maxInputTokens: Math.max(1, DEFAULT_CONTEXT_LENGTH - DEFAULT_MAX_TOKENS),
		maxOutputTokens: DEFAULT_MAX_TOKENS,
		isUserSelectable: false,
		statusIcon: new vscode.ThemeIcon("warning"),
		capabilities: {
			toolCalling: false,
			imageInput: false,
		},
	} satisfies ModelPickerChatInformation;
}

interface EndpointGroup {
	baseUrl: string;
	apiMode: HFApiMode;
	models: HFModelItem[];
}

/**
 * Merge configured models with the live model list of their providers.
 *
 * Configured models are grouped by the endpoint they actually talk to
 * (per-model `baseUrl`/`apiMode`, falling back to the global settings) and
 * each group is checked against that endpoint's `/models` response:
 * - configured models missing from the provider list are dropped;
 * - provider models without a configuration entry are exposed with default
 *   metadata so newly published models show up automatically.
 * Groups whose endpoint cannot be queried — missing URL, missing API key,
 * or a failed fetch (wrong URL/key, network error) — are hidden: configured
 * entries cannot be validated against the provider in that case and must
 * never be fabricated into the picker. When no group is queryable, the
 * result carries a `reason` so the caller renders a non-selectable
 * placeholder entry that keeps the provider section visible (returning an
 * empty array would make VS Code hide the provider section entirely).
 * Outage tolerance is provided by the TTL cache instead: a failed refresh
 * serves the previously successful (stale) listing when one exists (see
 * fetchModelsCached).
 */
async function mergeConfiguredModelWithProviders(options: {
	secrets: vscode.SecretStorage;
	configuredModels: HFModelItem[];
	globalBaseUrl: string;
}): Promise<{ models: HFModelItem[]; reason?: NoModelsReason }> {
	const { secrets, configuredModels, globalBaseUrl } = options;

	const groups = new Map<string, EndpointGroup>();
	for (const m of configuredModels) {
		const baseUrl = m.baseUrl || globalBaseUrl;
		const apiMode = m.apiMode ?? "openai";
		const key = `${apiMode}|${baseUrl}`;
		let group = groups.get(key);
		if (!group) {
			group = { baseUrl, apiMode, models: [] };
			groups.set(key, group);
		}
		group.models.push(m);
	}

	// Global id sets shared across all endpoint groups so every model is
	// exposed exactly once. Without this, two groups (e.g. "openai" and
	// "openai-responses" against the same gateway) each treat the other
	// group's configured models as "newly published" and expose the full
	// gateway listing again, duplicating every entry in the picker.
	const configuredIds = new Set(configuredModels.map((m) => m.id));
	const exposedIds = new Set<string>();

	const merged: HFModelItem[] = [];
	let queryableGroups = 0;
	let groupsMissingKey = 0;
	let groupsInvalidUrl = 0;
	const fetchErrors: string[] = [];
	for (const group of groups.values()) {
		const outcome = await fetchProviderModelsForGroup(group, secrets);
		if (outcome.kind !== "ok") {
			// No verified provider listing for this endpoint (missing URL,
			// missing key, or a failed fetch): hide the group instead of
			// fabricating unverified configured entries into the picker.
			if (outcome.kind === "notConfigured") {
				if (outcome.reason === "noApiKey") {
					groupsMissingKey++;
				} else {
					groupsInvalidUrl++;
				}
			} else {
				fetchErrors.push(`${group.baseUrl}: ${outcome.error}`);
			}
			continue;
		}
		queryableGroups++;

		const providerModels = outcome.models;
		const availableIds = new Set(providerModels.map((m) => m.id));
		for (const m of group.models) {
			if (availableIds.has(m.id)) {
				merged.push(m);
				exposedIds.add(m.id);
			} else {
				logger.warn("models.merge.configuredMissing", { modelId: m.id, baseUrl: group.baseUrl });
			}
		}

		// Expose provider models that have no configuration entry
		// (e.g. newly published models), with default metadata. Models
		// configured for any group (or already exposed by an earlier group)
		// are skipped so the listing never contains duplicates.
		const discovered = providerModels
			.filter((m) => !configuredIds.has(m.id) && !exposedIds.has(m.id))
			.sort((a, b) => a.id.localeCompare(b.id));
		for (const m of discovered) {
			merged.push(toDiscoveredModelItem(m));
			exposedIds.add(m.id);
		}
	}

	if (queryableGroups === 0) {
		// Nothing queryable: report why so the caller can render a
		// placeholder entry. Priority: fetch error > missing key > bad URL.
		logger.warn("models.merge.noQueryableGroups", {
			groupsMissingKey,
			groupsInvalidUrl,
			fetchErrors,
		});
		const reason: NoModelsReason =
			fetchErrors.length > 0
				? { kind: "fetchFailed", error: fetchErrors[0] }
				: groupsMissingKey > 0
					? { kind: "noApiKey" }
					: { kind: "invalidBaseUrl" };
		return { models: [], reason };
	}

	// A queryable provider may legitimately return an empty listing; the
	// caller then shows the placeholder without a configuration reason.
	return { models: merged };
}

/**
 * Result of querying one endpoint group.
 * - `ok`: the provider listing was fetched.
 * - `notConfigured`: the endpoint lacks a URL or API key.
 * - `failed`: the fetch itself failed at runtime (wrong URL/key, network).
 * Any non-`ok` outcome means the group is hidden: callers never fall back
 * to unverified configured entries.
 */
type GroupFetchOutcome =
	| { kind: "ok"; models: HFModelItem[] }
	| { kind: "notConfigured"; reason: "invalidBaseUrl" | "noApiKey" }
	| { kind: "failed"; error: string };

/**
 * Fetch the model list for one endpoint group. Any non-`ok` outcome (missing
 * URL/key, or a failed fetch) means the caller should hide the group rather
 * than show unverified configured entries.
 */
async function fetchProviderModelsForGroup(
	group: EndpointGroup,
	secrets: vscode.SecretStorage
): Promise<GroupFetchOutcome> {
	if (!group.baseUrl || !group.baseUrl.startsWith("http")) {
		logger.warn("models.merge.invalidBaseUrl", { baseUrl: group.baseUrl });
		return { kind: "notConfigured", reason: "invalidBaseUrl" };
	}

	const apiKey = await resolveGroupApiKey(group, secrets);
	if (!apiKey) {
		logger.warn("models.merge.noApiKey", { baseUrl: group.baseUrl });
		return { kind: "notConfigured", reason: "noApiKey" };
	}

	try {
		const { models } = await fetchModelsCached(group.baseUrl, apiKey, group.apiMode);
		return { kind: "ok", models };
	} catch (error) {
		logger.warn("models.merge.fetchFailed", {
			baseUrl: group.baseUrl,
			error: error instanceof Error ? error.message : String(error),
		});
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Resolve an API key for an endpoint group: the global key first, then any
 * provider-specific key referenced by the group's configured models.
 */
async function resolveGroupApiKey(group: EndpointGroup, secrets: vscode.SecretStorage): Promise<string | undefined> {
	const globalKey = await secrets.get("libiaoCopilot.apiKey");
	if (globalKey) {
		return globalKey;
	}

	const providers = Array.from(
		new Set(
			group.models
				.map((m) => m.owned_by?.toLowerCase().trim())
				.filter((p): p is string => typeof p === "string" && p !== "")
		)
	);
	for (const provider of providers) {
		const key = await secrets.get(`libiaoCopilot.apiKey.${provider}`);
		if (key) {
			return key;
		}
	}
	return undefined;
}

/**
 * Build a picker entry for a provider model that has no configuration,
 * deriving vision/context hints from the API response where available.
 *
 * When a built-in entry exists for the model id, it is the authoritative
 * metadata source: the gateway listing often under-reports the context
 * window and max tokens (e.g. reporting a model as 128K when the factory
 * entry declares 1M), so the built-in entry is merged over the live
 * listing while live-only fields are kept.
 *
 * Exported for direct unit testing of the fallback path (the merge path
 * requires a verifiable endpoint, which the test environment cannot provide).
 */
export function toDiscoveredModelItem(m: HFModelItem): HFModelItem {
	const builtIn = getBuiltInModel(m.id);
	const modalities = m.architecture?.input_modalities ?? [];
	const vision = m.vision ?? builtIn?.vision ?? (Array.isArray(modalities) && modalities.includes("image"));
	if (!builtIn) {
		return {
			...m,
			context_length: m.context_length ?? m.providers?.[0]?.context_length,
			vision,
		};
	}
	return {
		...m,
		...builtIn,
		vision,
	};
}

/**
 * Fetch the list of models and supplementary metadata from Provider.
 */
export async function fetchModels(
	baseUrl: string,
	apiKey: string,
	apiMode?: HFApiMode | string,
	customHeaders?: Record<string, string>
): Promise<{ models: HFModelItem[] }> {
	const normalizedApiMode = apiMode ?? "openai";
	if (normalizedApiMode === "gemini") {
		const models = await fetchGeminiModels(baseUrl, apiKey, customHeaders);
		return { models };
	} else if (normalizedApiMode === "ollama") {
		const models = await fetchOllamaModels(baseUrl, apiKey, customHeaders);
		return { models };
	}

	const modelsList = (async () => {
		const baseHeaders: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": VersionManager.getUserAgent(),
		};
		const headers = customHeaders ? { ...baseHeaders, ...customHeaders } : baseHeaders;
		const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers,
		});
		if (!resp.ok) {
			let text = "";
			try {
				text = await resp.text();
			} catch (error) {
				console.error("[OAI Compatible Model Provider] Failed to read response text", error);
			}
			const err = new Error(
				`Failed to fetch OAI Compatible models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
			);
			console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
			throw err;
		}
		const parsed = (await resp.json()) as HFModelsResponse;
		return parsed.data ?? [];
	})();

	try {
		const models = await modelsList;
		return { models };
	} catch (err) {
		const errorObj = err instanceof Error ? err : new Error(String(err));
		console.error("[OAI Compatible Model Provider] Failed to fetch OAI Compatible models", err);
		logger.error("models.fetch.error", { baseUrl, error: errorObj.message });
		throw err;
	}
}

/**
 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
 * @param silent If true, do not prompt the user.
 * @param secrets vscode.SecretStorage
 */
async function ensureApiKey(silent: boolean, secrets: vscode.SecretStorage): Promise<string | undefined> {
	// Fall back to generic API key
	let apiKey = await secrets.get("libiaoCopilot.apiKey");

	if (!apiKey && !silent) {
		const entered = await vscode.window.showInputBox({
			title: "OAI Compatible API Key",
			prompt: "Enter your OAI Compatible API key",
			ignoreFocusOut: true,
			password: true,
		});
		if (entered && entered.trim()) {
			apiKey = entered.trim();
			await secrets.store("libiaoCopilot.apiKey", apiKey);
		}
	}
	return apiKey;
}
