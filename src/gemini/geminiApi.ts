import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";
import type { OpenAIFunctionToolDef } from "../openai/openaiTypes";

import { CommonApi } from "../commonApi";
import { logger } from "../logger";
import {
	getConfiguredReasoningEffort,
	isReasoningEffortValue,
} from "../modelConfiguration";

import {
	isImageMimeType,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAI,
	mapRole,
	tryParseJSONObject,
} from "../utils";

import type {
	GeminiGenerateContentRequest,
	GeminiGenerateContentResponse,
	GeminiPart,
	GeminiToolConfig,
} from "./geminiTypes";

export interface GeminiChatMessage {
	role: "user" | "model" | "system";
	parts: GeminiPart[];
}

export interface GeminiToolCallMeta {
	name: string;
	thoughtSignature?: string;
	thought?: string;
	createdAt: number;
}

/**
 * 严格白名单：仅允许 Google Gemini OpenAPI 3.0 Schema 规范明确支持的合法字段。
 * 彻底废除脆弱的黑名单机制：未来无论 VS Code、Copilot 或 MCP 引入任何新的
 * JSON Schema 关键字（如 propertyNames, prefixItems, unevaluatedProperties, if/else 等），
 * 都会在转换时被自动安全过滤，从根源上杜绝 protojson 解析时的 400 Bad Request 报错。
 */
export const ALLOWED_GEMINI_SCHEMA_KEYS = new Set([
	"type",
	"format",
	"description",
	"nullable",
	"enum",
	"maxItems",
	"minItems",
	"properties",
	"required",
	"minProperties",
	"maxProperties",
	"minLength",
	"maxLength",
	"pattern",
	"anyOf",
	"items",
	"minimum",
	"maximum",
]);

export function stripUnsupportedGeminiSchemaKeys(value: unknown): number {
	if (!value || typeof value !== "object") {
		return 0;
	}

	if (Array.isArray(value)) {
		let removed = 0;
		for (const v of value) {
			removed += stripUnsupportedGeminiSchemaKeys(v);
		}
		return removed;
	}

	const obj = value as Record<string, unknown>;
	let removed = 0;

	for (const key of Object.keys(obj)) {
		if (!ALLOWED_GEMINI_SCHEMA_KEYS.has(key)) {
			delete obj[key];
			removed++;
			continue;
		}
		// properties 是"属性名 -> schema"的映射：key 是用户自定义属性名（如 dirPath），
		// 绝不能按关键字白名单过滤掉，否则 properties 变空而 required 仍在，
		// Gemini protojson 会报 `required[N]: property is not defined`。
		// 正确做法：只递归过滤每个属性的 value（它本身是 schema 对象）。
		if (key === "properties") {
			const props = obj[key];
			if (props && typeof props === "object" && !Array.isArray(props)) {
				for (const pk of Object.keys(props)) {
					removed += stripUnsupportedGeminiSchemaKeys((props as Record<string, unknown>)[pk]);
				}
			}
			continue;
		}
		removed += stripUnsupportedGeminiSchemaKeys(obj[key]);
	}

	return removed;
}

function normalizeBaseUrl(raw: string): string {
	const v = (raw || "").trim();
	if (!v) {
		return "";
	}
	try {
		return new URL(v).toString();
	} catch {
		// Try to recover from missing scheme
		if (!/^https?:\/\//i.test(v)) {
			try {
				return new URL(`https://${v}`).toString();
			} catch {
				return v;
			}
		}
		return v;
	}
}

function joinPathPrefix(basePath: string, nextPath: string): string {
	const a = basePath || "";
	const b = nextPath || "";
	const aTrim = a.endsWith("/") ? a.slice(0, -1) : a;
	const bTrim = b.startsWith("/") ? b : `/${b}`;
	return `${aTrim || ""}${bTrim}`;
}

/**
 * Build the Gemini models list endpoint URL from a base URL.
 * Handles various baseUrl formats: bare domain, /v1, /v1beta, or /v1beta/models.
 * @param baseUrl The base URL to normalize.
 * @returns The full models list endpoint URL.
 */
function buildGeminiModelsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1beta/models")) {
		return trimmed;
	}
	if (trimmed.endsWith("/v1beta")) {
		return `${trimmed}/models`;
	}
	// 把 /v1、/v1alpha、/v1beta/models 等版本段（含可选 /models）归一化为 /v1beta/models
	const versionSegmentRe = /\/v\d+[a-z0-9]*(\/models)?$/i;
	if (versionSegmentRe.test(trimmed)) {
		return `${trimmed.replace(versionSegmentRe, "")}/v1beta/models`;
	}
	return `${trimmed}/v1beta/models`;
}

/**
 * Normalize a Gemini model identifier by stripping the "models/" prefix.
 * @param name The model name from the API response.
 * @param displayName The display name from the API response.
 * @returns A normalized model ID suitable for user configuration.
 */
function normalizeGeminiModelIdForListing(name?: string, displayName?: string): string {
	if (name && name.trim()) {
		if (name.startsWith("models/")) {
			return name.slice("models/".length);
		}
		return name;
	}
	return displayName?.trim() || "unknown";
}

function normalizeGeminiModelPath(modelId: string): string {
	const raw = (modelId || "").trim();
	if (!raw) {
		return "models/gemini-3-pro-preview";
	}

	const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
	if (last.startsWith("models/") || last.startsWith("tunedModels/")) {
		return last;
	}

	if (last.includes("..") || last.includes("?") || last.includes("&")) {
		return "";
	}

	return `models/${last}`;
}

export function buildGeminiGenerateContentUrl(rawBaseUrl: string, modelId: string, stream: boolean): string {
	const value = (rawBaseUrl || "").trim();
	if (!value) {
		return "";
	}

	try {
		const normalized = normalizeBaseUrl(value);
		const u0 = new URL(normalized);
		let basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";

		// If configured as a full endpoint, keep it (just switch method based on stream).
		if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
			const method = stream ? "streamGenerateContent" : "generateContent";
			u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
			u0.search = "";
			u0.hash = "";
			if (stream) {
				u0.searchParams.set("alt", "sse");
			}
			return u0.toString();
		}

		const modelPath = normalizeGeminiModelPath(modelId);
		if (!modelPath) {
			return "";
		}

		// basePath 语义：基础路径（不含版本段与 models 前缀）。若配置的是
		// /v1beta、/v1beta/models、/v1、/v1alpha 等，统一截掉版本段及其后的
		// /models 段，最终归一化为 /v1beta。这样裸域名、/v1、/v1beta、
		// /v1beta/models 配置都得到正确的 /v1beta/models/<model>:... 路径。
		const versionSegmentRe = /\/v\d+[a-z0-9]*(\/models)?(\/|$)/i;
		if (versionSegmentRe.test(`${basePath}/`)) {
			basePath = basePath.replace(versionSegmentRe, "") || "/";
		}
		basePath = joinPathPrefix(basePath, "/v1beta");

		const method = stream ? "streamGenerateContent" : "generateContent";
		u0.pathname = joinPathPrefix(basePath, `/${modelPath}:${method}`);
		u0.search = "";
		u0.hash = "";
		if (stream) {
			u0.searchParams.set("alt", "sse");
		}
		return u0.toString();
	} catch {
		return "";
	}
}

function jsonSchemaToGeminiSchema(
	jsonSchema: unknown,
	rootSchema: unknown = jsonSchema,
	refStack: Set<string> | undefined = undefined
): Record<string, unknown> {
	if (!jsonSchema || typeof jsonSchema !== "object") {
		return {};
	}

	const root =
		rootSchema && typeof rootSchema === "object"
			? (rootSchema as Record<string, unknown>)
			: (jsonSchema as Record<string, unknown>);
	const stack = refStack instanceof Set ? refStack : new Set<string>();

	const ref =
		typeof (jsonSchema as Record<string, unknown>).$ref === "string"
			? String((jsonSchema as Record<string, unknown>).$ref).trim()
			: "";
	if (ref) {
		if (stack.has(ref)) {
			return {};
		}
		stack.add(ref);

		const resolved = (() => {
			if (ref === "#") {
				return root;
			}
			if (!ref.startsWith("#/")) {
				return null;
			}
			const decode = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
			const parts = ref
				.slice(2)
				.split("/")
				.map((p) => decode(p));

			let cur: unknown = root;
			for (const p of parts) {
				if (!cur || typeof cur !== "object") {
					return null;
				}
				if (!(p in (cur as Record<string, unknown>))) {
					return null;
				}
				cur = (cur as Record<string, unknown>)[p];
			}
			return cur && typeof cur === "object" ? (cur as Record<string, unknown>) : null;
		})();

		const merged: Record<string, unknown> = {
			...(resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {}),
			...(jsonSchema as Record<string, unknown>),
		};
		delete merged.$ref;
		const out = jsonSchemaToGeminiSchema(merged, root, stack);
		stack.delete(ref);
		return out;
	}

	const allOf = Array.isArray((jsonSchema as Record<string, unknown>).allOf)
		? ((jsonSchema as Record<string, unknown>).allOf as unknown[])
		: null;
	if (allOf && allOf.length > 0) {
		const merged: Record<string, unknown> = { ...(jsonSchema as Record<string, unknown>) };
		delete merged.allOf;
		for (const it of allOf) {
			if (!it || typeof it !== "object") {
				continue;
			}
			const itObj = it as Record<string, unknown>;
			for (const [k, v] of Object.entries(itObj)) {
				if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
					const baseProps =
						merged.properties && typeof merged.properties === "object" && !Array.isArray(merged.properties)
							? (merged.properties as Record<string, unknown>)
							: {};
					merged.properties = { ...baseProps, ...(v as Record<string, unknown>) };
					continue;
				}
				if (k === "required" && Array.isArray(v)) {
					const baseReq = Array.isArray(merged.required) ? (merged.required as unknown[]) : [];
					merged.required = Array.from(new Set([...baseReq, ...v]));
					continue;
				}
				if (!(k in merged)) {
					merged[k] = v;
				}
			}
		}
		return jsonSchemaToGeminiSchema(merged, root, stack);
	}

	const out: Record<string, unknown> = {};
	const input = { ...(jsonSchema as Record<string, unknown>) };

	// Handle nullable unions like { anyOf: [{type:'null'}, {...}] }
	const anyOf = Array.isArray(input.anyOf)
		? (input.anyOf as unknown[])
		: Array.isArray(input.oneOf)
			? (input.oneOf as unknown[])
			: null;
	if (anyOf && anyOf.length === 2) {
		const a0 = anyOf[0] && typeof anyOf[0] === "object" ? (anyOf[0] as Record<string, unknown>) : null;
		const a1 = anyOf[1] && typeof anyOf[1] === "object" ? (anyOf[1] as Record<string, unknown>) : null;
		if (a0?.type === "null") {
			out.nullable = true;
			return { ...out, ...jsonSchemaToGeminiSchema(a1, root, stack) };
		}
		if (a1?.type === "null") {
			out.nullable = true;
			return { ...out, ...jsonSchemaToGeminiSchema(a0, root, stack) };
		}
	}

	if (Array.isArray(input.type)) {
		const list = (input.type as unknown[]).filter((t) => typeof t === "string");
		if (list.length) {
			out.anyOf = list
				.filter((t) => t !== "null")
				.map((t) => jsonSchemaToGeminiSchema({ ...input, type: t, anyOf: undefined, oneOf: undefined }, root, stack));
			if (list.includes("null")) {
				out.nullable = true;
			}
			return out;
		}
	}

	// 专门处理 Draft-07 exclusiveMinimum/exclusiveMaximum
	if (typeof input.exclusiveMinimum === "number" && input.minimum === undefined) {
		out.minimum = input.exclusiveMinimum;
	}
	if (typeof input.exclusiveMaximum === "number" && input.maximum === undefined) {
		out.maximum = input.exclusiveMaximum;
	}

	// 专门处理 const -> enum
	if (input.const !== undefined && input.enum === undefined) {
		out.enum = [input.const];
	}

	for (const [k, v] of Object.entries(input)) {
		if (v == null) {
			continue;
		}

		if (k === "type") {
			if (typeof v === "string" && v !== "null") {
				out.type = String(v).toUpperCase();
			}
			continue;
		}

		if (k === "items") {
			if (v && typeof v === "object") {
				out.items = jsonSchemaToGeminiSchema(v, root, stack);
			}
			continue;
		}

		if (k === "properties") {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				const m: Record<string, unknown> = {};
				for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
					if (pv && typeof pv === "object") {
						m[pk] = jsonSchemaToGeminiSchema(pv, root, stack);
					}
				}
				out.properties = m;
			}
			continue;
		}

		if (k === "anyOf" || k === "oneOf") {
			if (Array.isArray(v)) {
				const arr: unknown[] = [];
				for (const it of v) {
					if (it && typeof it === "object") {
						arr.push(jsonSchemaToGeminiSchema(it, root, stack));
					}
				}
				out.anyOf = arr;
			}
			continue;
		}

		// 严格白名单过滤：只收录 Google Gemini 官方 Schema 规范支持的合法字段，
		// 其余所有未知的、非标准的、未来的 JSON Schema 关键字（如 propertyNames, if/else, $schema 等）一律自动丢弃！
		if (ALLOWED_GEMINI_SCHEMA_KEYS.has(k)) {
			out[k] = v;
		}
	}

	// Gemini Schema types are enum-like uppercase strings; if absent but properties exist, treat as OBJECT.
	if (!out.type && out.properties && typeof out.properties === "object") {
		out.type = "OBJECT";
	}

	return out;
}

function openaiToolsToGeminiFunctionDeclarations(
	tools: OpenAIFunctionToolDef[]
): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> {
	const out: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = [];
	for (const t of Array.isArray(tools) ? tools : []) {
		if (!t || typeof t !== "object") {
			continue;
		}
		if (t.type !== "function") {
			continue;
		}
		const fn = t.function;
		const name = typeof fn?.name === "string" ? fn.name.trim() : "";
		if (!name) {
			continue;
		}
		const decl: { name: string; description?: string; parameters?: Record<string, unknown> } = { name };
		if (typeof fn.description === "string" && fn.description.trim()) {
			decl.description = fn.description;
		}
		if (fn.parameters && typeof fn.parameters === "object") {
			decl.parameters = jsonSchemaToGeminiSchema(fn.parameters);
			stripUnsupportedGeminiSchemaKeys(decl.parameters);
		}
		out.push(decl);
	}
	return out;
}

function openaiToolChoiceToGeminiToolConfig(toolChoice: unknown): GeminiToolConfig | null {
	if (toolChoice == null) {
		return null;
	}

	if (typeof toolChoice === "string") {
		const v = toolChoice.trim().toLowerCase();
		if (v === "none") {
			return { functionCallingConfig: { mode: "NONE" } };
		}
		if (v === "required" || v === "any") {
			return { functionCallingConfig: { mode: "ANY" } };
		}
		return { functionCallingConfig: { mode: "AUTO" } };
	}

	if (typeof toolChoice === "object") {
		const obj = toolChoice as Record<string, unknown>;
		if (obj.type === "function") {
			const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : null;
			const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
			if (name) {
				return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
			}
		}
	}

	return null;
}

export class GeminiApi extends CommonApi<GeminiChatMessage, GeminiGenerateContentRequest> {
	constructor(
		modelId: string,
		private readonly toolCallMetaByCallId?: Map<string, GeminiToolCallMeta>
	) {
		super(modelId);
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): GeminiChatMessage[] {
		const out: GeminiChatMessage[] = [];
		const toolNameByCallId = new Map<string, string>();

		const extractMessageParts = (m: LanguageModelChatRequestMessage) => {
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
			const toolResults: Array<{ callId: string; outputText: string }> = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const callId = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const args = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
					toolCalls.push({ callId, name: part.name, args });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const outputText = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, outputText });
				}
			}

			return { text: textParts.join("").trim(), imageParts, toolCalls, toolResults };
		};

		const toolResultToFunctionResponsePart = (
			callId: string,
			outputText: string,
			fallbackName = ""
		): GeminiPart | null => {
			if (!callId) {
				return null;
			}
			const meta = this.toolCallMetaByCallId?.get(callId);
			const name = toolNameByCallId.get(callId) ?? meta?.name ?? fallbackName;
			if (!name) {
				return null;
			}

			const parsed = tryParseJSONObject(outputText);
			const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { output: outputText };
			return { functionResponse: { name, response: responseValue } };
		};

		const isToolResultOnly = (extracted: {
			text: string;
			imageParts: vscode.LanguageModelDataPart[];
			toolCalls: Array<unknown>;
			toolResults: Array<unknown>;
		}): boolean => {
			return Boolean(
				extracted.toolResults.length > 0 &&
					!extracted.text &&
					extracted.imageParts.length === 0 &&
					extracted.toolCalls.length === 0
			);
		};

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const role = mapRole(m);
			const extracted = extractMessageParts(m);

			// Best-effort: group consecutive tool results into a single user turn.
			if (isToolResultOnly(extracted)) {
				const respParts: GeminiPart[] = [];
				let j = i;
				while (j < messages.length) {
					const ex2 = extractMessageParts(messages[j]);
					if (!isToolResultOnly(ex2)) {
						break;
					}
					for (const tr of ex2.toolResults) {
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
						if (part) {
							respParts.push(part);
						}
					}
					j++;
				}
				if (respParts.length > 0) {
					out.push({ role: "user", parts: respParts });
				}
				i = j - 1;
				continue;
			}

			if (role === "system") {
				if (extracted.text) {
					out.push({ role: "system", parts: [{ text: extracted.text }] });
				}
				continue;
			}

			if (role === "user") {
				const parts: GeminiPart[] = [];
				if (extracted.text) {
					parts.push({ text: extracted.text });
				}
				for (const img of extracted.imageParts) {
					const data = Buffer.from(img.data).toString("base64");
					parts.push({ inlineData: { mimeType: img.mimeType, data } });
				}
				if (parts.length > 0) {
					out.push({ role: "user", parts });
				}
				continue;
			}

			// assistant -> Gemini "model"
			const parts: GeminiPart[] = [];
			if (extracted.text) {
				parts.push({ text: extracted.text });
			}

			const callOrder: Array<{ callId: string; name: string }> = [];
			for (const tc of extracted.toolCalls) {
				const callId = tc.callId;
				const name = tc.name;
				toolNameByCallId.set(callId, name);
				callOrder.push({ callId, name });

				const fcPart: Record<string, unknown> = {
					functionCall: { name, args: tc.args },
				};
				const meta = this.toolCallMetaByCallId?.get(callId);
				if (meta?.thoughtSignature) {
					fcPart.thoughtSignature = meta.thoughtSignature;
				}
				if (meta?.thought) {
					fcPart.thought = meta.thought;
				}
				parts.push(fcPart as GeminiPart);
			}

			if (parts.length > 0) {
				out.push({ role: "model", parts });
			}

			// Gemini requires that tool responses are provided as a single "user" turn
			// containing the same number of functionResponse parts as the preceding model's functionCall parts.
			if (callOrder.length > 0) {
				const responsesByCallId = new Map<string, GeminiPart>();
				let j = i + 1;
				while (j < messages.length) {
					const ex2 = extractMessageParts(messages[j]);
					if (!isToolResultOnly(ex2)) {
						break;
					}
					for (const tr of ex2.toolResults) {
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
						if (part) {
							responsesByCallId.set(tr.callId, part);
						}
					}
					j++;
				}

				if (responsesByCallId.size > 0) {
					const respParts: GeminiPart[] = [];
					for (const c of callOrder) {
						const found = responsesByCallId.get(c.callId);
						if (found) {
							respParts.push(found);
						} else {
							respParts.push({ functionResponse: { name: c.name, response: { output: "" } } });
						}
					}
					out.push({ role: "user", parts: respParts });
					i = j - 1;
				}
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: GeminiGenerateContentRequest,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): GeminiGenerateContentRequest {
		const generationConfig: Record<string, unknown> = {
			...(rb.generationConfig && typeof rb.generationConfig === "object"
				? (rb.generationConfig as Record<string, unknown>)
				: {}),
		};

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			generationConfig.temperature = um.temperature;
		}

		// topP/topK
		if (um?.top_p !== undefined && um.top_p !== null) {
			generationConfig.topP = um.top_p;
		}
		if (um?.top_k !== undefined && um.top_k !== null) {
			generationConfig.topK = um.top_k;
		}

		// maxOutputTokens
		const maxOutput =
			um?.max_completion_tokens !== undefined
				? um.max_completion_tokens
				: um?.max_tokens !== undefined
					? um.max_tokens
					: undefined;
		if (maxOutput !== undefined) {
			generationConfig.maxOutputTokens = maxOutput;
		}

		// stop sequences
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" && mo.stop) {
				generationConfig.stopSequences = [mo.stop];
			} else if (Array.isArray(mo.stop)) {
				generationConfig.stopSequences = mo.stop.filter((s) => typeof s === "string" && s);
			}
		}

		// penalties
		if (um?.presence_penalty !== undefined) {
			generationConfig.presencePenalty = um.presence_penalty;
		}
		if (um?.frequency_penalty !== undefined) {
			generationConfig.frequencyPenalty = um.frequency_penalty;
		}

		// reasoning_effort -> thinkingConfig (thinkingLevel + includeThoughts)
		// 注意：Google Gemini API 默认 includeThoughts 为 false（静默思考，不回传思考过程文本，只在 usage 计入 token）；
		// 必须显式置 includeThoughts: true，客户端才能收到思考流分片并实时渲染思考框。
		// 当 effort 为 "auto" 时，不设置 thinkingLevel（走 Google 官方默认的动态自适应思考 Dynamic Thinking）。
		if (um?.reasoning_efforts && um.reasoning_efforts.length > 0) {
			const allowedEfforts = um.reasoning_efforts.filter(isReasoningEffortValue);
			const defaultEffort = isReasoningEffortValue(um.reasoning_effort) ? um.reasoning_effort : undefined;
			const effort = getConfiguredReasoningEffort(options, defaultEffort, allowedEfforts);
			if (effort) {
				const thinkingConfig: Record<string, unknown> = {
					includeThoughts: true,
				};
				if (effort !== "auto") {
					thinkingConfig.thinkingLevel = effort.toUpperCase();
				}
				generationConfig.thinkingConfig = thinkingConfig;
			}
		} else if (um?.reasoning_effort !== undefined && isReasoningEffortValue(um.reasoning_effort)) {
			const thinkingConfig: Record<string, unknown> = {
				includeThoughts: true,
			};
			if (um.reasoning_effort !== "auto") {
				thinkingConfig.thinkingLevel = um.reasoning_effort.toUpperCase();
			}
			generationConfig.thinkingConfig = thinkingConfig;
		}

		if (Object.keys(generationConfig).length > 0) {
			rb.generationConfig = generationConfig;
		}

		// tools/toolConfig (from VS Code tools + toolMode)
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools && toolConfig.tools.length > 0) {
			const decls = openaiToolsToGeminiFunctionDeclarations(toolConfig.tools);
			if (decls.length > 0) {
				rb.tools = [{ functionDeclarations: decls }];
				const tc = openaiToolChoiceToGeminiToolConfig(toolConfig.tool_choice);
				if (tc) {
					rb.toolConfig = tc;
				}
			}
		}

		// extra parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					if (key === "tools" && Array.isArray(value) && rb.tools) {
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
		const modelId = this._modelId;
		logger.debug("gemini.stream.start", { modelId });
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		let textSoFar = "";
		const toolCallKeyToId = new Map<string, string>();
		let pendingThoughtSoFar = "";
		let pendingThoughtSummarySoFar = "";
		let pendingThoughtSignature = "";

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
					logger.debug("gemini.stream.chunk", { modelId, data });
					if (!data || data === "[DONE]") {
						continue;
					}

					let payload: GeminiGenerateContentResponse | null = null;
					try {
						payload = JSON.parse(data) as GeminiGenerateContentResponse;
					} catch (e) {
						console.error("[Gemini Provider] Failed to parse streaming chunk:", e, "data:", data);
						logger.error("gemini.stream.chunk.error", {
							modelId,
							error: e instanceof Error ? e.message : String(e),
							data,
						});
						continue;
					}
					if (!payload) {
						continue;
					}

					// Capture usage metadata from Gemini response
					if (payload.usageMetadata) {
						const um = payload.usageMetadata;
						const thoughts = typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
						const candidates = typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0;
						const totalOutput = candidates + thoughts;
						this._usage = {
							prompt_tokens: um.promptTokenCount ?? 0,
							completion_tokens: totalOutput,
							total_tokens: um.totalTokenCount ?? (um.promptTokenCount ?? 0) + totalOutput,
							prompt_tokens_details: um.cachedContentTokenCount
								? { cached_tokens: um.cachedContentTokenCount }
								: undefined,
							completion_tokens_details:
								thoughts > 0
									? { reasoning_tokens: thoughts }
									: undefined,
						};
						logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
					}

					const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
					const cand = candidates.length > 0 ? candidates[0] : null;
					const parts = Array.isArray(cand?.content?.parts) ? cand?.content?.parts : [];

					for (const p of parts) {
						const fc = p?.functionCall;
						if (!fc || typeof fc !== "object") {
							// Standalone thought (Gemini "thought summaries" or 2025 API: thought comes in separate part)
							const maybeThought = p && typeof p === "object" ? (p as unknown as Record<string, unknown>) : null;
							const thoughtSummaryText =
								maybeThought && maybeThought.thought === true && typeof (p as GeminiPart).text === "string"
									? String((p as GeminiPart).text)
									: "";
							const thought = maybeThought && typeof maybeThought.thought === "string" ? maybeThought.thought : "";
							const thoughtSigRaw =
								maybeThought && typeof maybeThought.thoughtSignature === "string"
									? maybeThought.thoughtSignature
									: maybeThought && typeof maybeThought.thought_signature === "string"
										? maybeThought.thought_signature
										: "";
							if (thoughtSummaryText) {
								let delta = "";
								if (thoughtSummaryText.startsWith(pendingThoughtSummarySoFar)) {
									delta = thoughtSummaryText.slice(pendingThoughtSummarySoFar.length);
									pendingThoughtSummarySoFar = thoughtSummaryText;
								} else if (pendingThoughtSummarySoFar.startsWith(thoughtSummaryText)) {
									delta = "";
								} else {
									delta = thoughtSummaryText;
									pendingThoughtSummarySoFar += thoughtSummaryText;
								}
								if (delta) {
									this.bufferThinkingContent(delta, progress);
								}
							}
							if (thought) {
								let delta = "";
								if (thought.startsWith(pendingThoughtSoFar)) {
									delta = thought.slice(pendingThoughtSoFar.length);
									pendingThoughtSoFar = thought;
								} else if (pendingThoughtSoFar.startsWith(thought)) {
									delta = "";
								} else {
									delta = thought;
									pendingThoughtSoFar += thought;
								}

								if (delta) {
									this.bufferThinkingContent(delta, progress);
								}
							}
							if (thoughtSigRaw) {
								pendingThoughtSignature = thoughtSigRaw;
							}
							continue;
						}
						const name =
							typeof (fc as { name?: unknown }).name === "string" ? String((fc as { name: string }).name).trim() : "";
						if (!name) {
							continue;
						}
						const argsRaw = (fc as { args?: unknown }).args;
						const argsObj =
							argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
								? (argsRaw as Record<string, unknown>)
								: {};
						const key = `${name}\n${JSON.stringify(argsObj)}`;

						const pObj = p && typeof p === "object" ? (p as unknown as Record<string, unknown>) : null;
						const fcObj = fc && typeof fc === "object" ? (fc as unknown as Record<string, unknown>) : null;
						const thoughtSigRaw =
							(pObj && typeof pObj.thoughtSignature === "string" ? pObj.thoughtSignature : "") ||
							(pObj && typeof pObj.thought_signature === "string" ? pObj.thought_signature : "") ||
							(fcObj && typeof fcObj.thoughtSignature === "string" ? fcObj.thoughtSignature : "") ||
							(fcObj && typeof fcObj.thought_signature === "string" ? fcObj.thought_signature : "") ||
							pendingThoughtSignature;
						const thoughtRaw =
							(pObj && typeof pObj.thought === "string" ? pObj.thought : "") ||
							(fcObj && typeof fcObj.thought === "string" ? fcObj.thought : "") ||
							pendingThoughtSoFar;

						if (thoughtRaw) {
							let delta = "";
							if (thoughtRaw.startsWith(pendingThoughtSoFar)) {
								delta = thoughtRaw.slice(pendingThoughtSoFar.length);
								pendingThoughtSoFar = thoughtRaw;
							} else if (pendingThoughtSoFar.startsWith(thoughtRaw)) {
								delta = "";
							} else {
								delta = thoughtRaw;
								pendingThoughtSoFar += thoughtRaw;
							}

							if (delta) {
								this.bufferThinkingContent(delta, progress);
							}
						}

						let id = toolCallKeyToId.get(key);
						const isNew = !id;
						if (!id) {
							id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
							toolCallKeyToId.set(key, id);
						}

						// Cache thoughtSignature/thought for Gemini thinking models (2025 API requirement)
						if (this.toolCallMetaByCallId) {
							this.toolCallMetaByCallId.set(id, {
								name,
								thoughtSignature: thoughtSigRaw || undefined,
								thought: thoughtRaw || undefined,
								createdAt: Date.now(),
							});
							// Basic pruning to avoid unbounded growth.
							const maxEntries = 2000;
							const pruneTo = 1500;
							if (this.toolCallMetaByCallId.size > maxEntries) {
								while (this.toolCallMetaByCallId.size > pruneTo) {
									const first = this.toolCallMetaByCallId.keys().next().value as string | undefined;
									if (!first) {
										break;
									}
									this.toolCallMetaByCallId.delete(first);
								}
							}
						}

						if (isNew) {
							this.reportEndThinking(progress);
							pendingThoughtSoFar = "";
							pendingThoughtSummarySoFar = "";
							pendingThoughtSignature = "";
							if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
								progress.report(new vscode.LanguageModelTextPart(" "));
								this._emittedBeginToolCallsHint = true;
							}
							progress.report(new vscode.LanguageModelToolCallPart(id, name, argsObj));
						}
					}

					const textJoined = parts
						.map((p) => {
							if (!p || typeof p !== "object") {
								return "";
							}
							const obj = p as unknown as Record<string, unknown>;
							// Thought summary text comes through as `text` with `thought: true`
							if (obj.thought === true) {
								return "";
							}
							return typeof (p as GeminiPart).text === "string" ? String((p as GeminiPart).text) : "";
						})
						.filter(Boolean)
						.join("");

					if (textJoined) {
						let delta = "";
						if (textJoined.startsWith(textSoFar)) {
							delta = textJoined.slice(textSoFar.length);
							textSoFar = textJoined;
						} else if (textSoFar.startsWith(textJoined)) {
							delta = "";
						} else {
							delta = textJoined;
							textSoFar += textJoined;
						}

						if (delta) {
							this.reportEndThinking(progress);
							pendingThoughtSoFar = "";
							pendingThoughtSummarySoFar = "";
							pendingThoughtSignature = "";
							progress.report(new vscode.LanguageModelTextPart(delta));
							this._hasEmittedAssistantText = true;
						}
					}
				}
			}
			logger.debug("gemini.stream.done", { modelId });
		} catch (e) {
			console.error("[Gemini Provider] Streaming response error:", e);
			logger.error("gemini.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
			// 冲刷 XML think 挂起缓冲（先于收尾：激活时挂起归入思考缓冲，随收尾同步冲刷）
			this.flushXmlThinkPending(progress);
			this.reportEndThinking(progress);
			// Report accumulated usage for the Context Window widget
			this.reportUsage(progress);
		}
	}

	// eslint-disable-next-line require-yield
	async *createMessage(
		_model: HFModelItem,
		_systemPrompt: string,
		_messages: { role: string; content: string }[],
		_baseUrl: string,
		_apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }> {
		throw new Error("Method not implemented.");
	}
}

/**
 * Fetch available models from a Gemini API endpoint.
 * Supports both native Google Gemini and Langdock Google proxy endpoints.
 * @param baseUrl The Gemini API base URL.
 * @param apiKey The API key for authentication.
 * @param customHeaders Optional custom headers to merge with defaults.
 * @returns A promise that resolves to an array of model items.
 */
export async function fetchGeminiModels(
	baseUrl: string,
	apiKey: string,
	customHeaders?: Record<string, string>
): Promise<HFModelItem[]> {
	const listUrl = buildGeminiModelsUrl(baseUrl);
	const ownedBy = baseUrl.includes("langdock.com") ? "langdock" : "google";
	const headers = CommonApi.prepareHeaders(apiKey, "gemini", customHeaders);
	headers["Accept"] = "application/json";

	const models: HFModelItem[] = [];
	let nextPageToken: string | undefined;
	let page = 0;

	while (page < 10) {
		const url = new URL(listUrl);
		if (nextPageToken) {
			url.searchParams.set("pageToken", nextPageToken);
		}

		const resp = await fetch(url.toString(), {
			method: "GET",
			headers,
		});
		if (!resp.ok) {
			let errorText = "";
			try {
				errorText = await resp.text();
			} catch (error) {
				console.error("[OAI Compatible Model Provider] Failed to read response text", error);
			}
			throw new Error(
				`Gemini API error: [${resp.status}] ${resp.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url.toString()}`
			);
		}

		const parsed = (await resp.json()) as import("./geminiTypes").GeminiModelListResponse;
		const entries = parsed.models ?? [];
		for (const entry of entries) {
			const id = normalizeGeminiModelIdForListing(entry.name, entry.displayName);
			models.push({
				id,
				displayName: entry.displayName || id,
				owned_by: ownedBy,
				context_length: entry.inputTokenLimit,
				max_completion_tokens: entry.outputTokenLimit,
				apiMode: "gemini",
			} as HFModelItem);
		}

		nextPageToken = parsed.nextPageToken;
		if (!nextPageToken) {
			break;
		}
		page += 1;
	}

	return models;
}
