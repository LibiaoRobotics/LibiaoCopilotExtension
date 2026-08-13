import * as vscode from "vscode";
import type { CancellationToken, LanguageModelChatRequestMessage } from "vscode";
import type { HFApiMode, RetryConfig } from "./types";
import { collectToolResultText, executeWithRetry, isToolResultPart, mapRole } from "./utils";
import { buildGeminiGenerateContentUrl } from "./gemini/geminiApi";
import { logger } from "./logger";
import { textTokenLength } from "./provideToken";

/**
 * System prompt template for the summarization call. Mirrors the structure
 * GitHub Copilot Chat uses for its conversation compaction: a fixed section
 * layout plus hard rules that preserve technical details.
 */
const SUMMARY_SYSTEM_TEMPLATE = `You are an expert conversation summarizer for a coding assistant. Your task is to compress an older portion of a conversation into a concise summary that will replace it in the context window.

Structure your summary using exactly the following sections:
## User Goals
## Completed Work
## Current State
## Recent Operations and Tool Results
## Pending Items

Rules:
- Be factual and specific. Preserve key technical details verbatim where they matter: file paths, function names, identifiers, command lines, error messages, configuration values, and API responses.
- Keep the summary under 3000 words. Dense is better than complete; details already in the retained recent messages do not need repeating.
- Do not speculate about events that are not in the provided history.
- Write the summary in the same language as the conversation.`;

/**
 * User prompt template for the summarization call, ported from the prompt
 * GitHub Copilot Chat ships in its own extension (including the no-tool-calls
 * guard, which prevents summarization from recursing into agent loops).
 */
const SUMMARY_USER_TEMPLATE = `Summarize the conversation history so far, paying special attention to the most recent agent commands and tool results that triggered this summarization. Structure your summary using the format provided in the system message.

IMPORTANT: Do NOT call any tools. Your only task is to generate a text summary of the conversation. Do not attempt to execute any actions or make any tool calls.

Focus particularly on:
- The specific agent commands/tools that were just executed
- The results returned from these recent tool calls (truncate if very long but preserve key information)
- What the agent was actively working on when the token budget was exceeded
- How these recent operations connect to the overall user goals

Include all important tool calls and their results as part of the appropriate sections, with special emphasis on the most recent operations.

<conversation history>
{transcript}
</conversation history>`;

const DEFAULT_MAX_TRANSCRIPT_CHARS = 120_000;
const SUMMARY_TIMEOUT_MS = 90_000;

export interface SummaryRequestContext {
	apiMode: HFApiMode;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	headers: Record<string, string>;
	retryConfig: RetryConfig;
	/** Optional user-provided extra instructions appended to the system prompt. */
	summarizationInstructions: string;
	/** Maximum number of tokens the summary itself may produce. */
	maxOutputTokens: number;
	token?: CancellationToken;
}

function buildSummaryPrompt(transcript: string, instructions: string): { system: string; user: string } {
	let system = SUMMARY_SYSTEM_TEMPLATE;
	const trimmedInstructions = instructions.trim();
	if (trimmedInstructions) {
		system += `\n\n## Additional instructions from the user:\n${trimmedInstructions}`;
	}
	const user = SUMMARY_USER_TEMPLATE.replace("{transcript}", () => transcript);
	return { system, user };
}

/**
 * Serializes non-system messages into a plain-text transcript for the
 * summarizer. Tool calls and results are rendered as text so the summary can
 * reference them; images and thinking traces are omitted on purpose.
 */
export function buildConversationTranscript(
	messages: readonly LanguageModelChatRequestMessage[],
	maxChars: number = DEFAULT_MAX_TRANSCRIPT_CHARS
): string {
	const lines: string[] = [];
	for (const message of messages) {
		const role = mapRole(message);
		if (role === "system") {
			continue;
		}
		for (const part of message.content ?? []) {
			let text = "";
			if (part instanceof vscode.LanguageModelTextPart) {
				text = part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				let input = "";
				try {
					input = JSON.stringify(part.input ?? {});
				} catch {
					input = "{}";
				}
				text = `Called tool "${part.name}" with input ${input}`;
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				text = `Tool result (call ${callId}): ${content}`;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType === "cache_control") {
					continue;
				}
				text = part.mimeType.startsWith("image/") ? "[image omitted]" : "[binary data omitted]";
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				continue;
			}
			const trimmed = text.trim();
			if (trimmed) {
				lines.push(`[${role}] ${trimmed}`);
			}
		}
	}
	let transcript = lines.join("\n");
	if (transcript.length > maxChars) {
		// Keep the most recent portion: it matters most for continuity.
		transcript = `…(earlier history omitted)…\n${transcript.slice(transcript.length - maxChars)}`;
	}
	return transcript;
}

interface SummaryHttpOutcome {
	summary: string;
}

function extractSummary(apiMode: HFApiMode, data: unknown): string {
	const root = data as Record<string, unknown>;
	switch (apiMode) {
		case "openai": {
			const choices = root.choices as Array<Record<string, unknown>> | undefined;
			const message = choices?.[0]?.message as Record<string, unknown> | undefined;
			const text = typeof message?.content === "string" ? message.content : "";
			if (text.trim()) {
				return text;
			}
			if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) {
				return message.reasoning_content;
			}
			break;
		}
		case "ollama": {
			const message = root.message as Record<string, unknown> | undefined;
			if (typeof message?.content === "string") {
				return message.content;
			}
			break;
		}
		case "anthropic": {
			const content = root.content as Array<Record<string, unknown>> | undefined;
			const first = content?.find((block) => block?.type === "text");
			if (typeof first?.text === "string") {
				return first.text;
			}
			break;
		}
		case "gemini": {
			const candidates = root.candidates as Array<Record<string, unknown>> | undefined;
			const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
			const parts = content?.parts as Array<Record<string, unknown>> | undefined;
			const text = (parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
			if (text.trim()) {
				return text;
			}
			break;
		}
		case "openai-responses": {
			if (typeof root.output_text === "string" && root.output_text.trim()) {
				return root.output_text;
			}
			const output = root.output as Array<Record<string, unknown>> | undefined;
			for (const item of output ?? []) {
				if (item?.type === "message") {
					const content = item.content as Array<Record<string, unknown>> | undefined;
					const text = (content ?? [])
						.filter((block) => block?.type === "output_text")
						.map((block) => (typeof block.text === "string" ? block.text : ""))
						.join("");
					if (text.trim()) {
						return text;
					}
				}
			}
			break;
		}
	}
	throw new Error(`Unable to extract summary text from ${apiMode} response`);
}

async function sendSummaryRequest(
	system: string,
	user: string,
	ctx: SummaryRequestContext
): Promise<SummaryHttpOutcome> {
	const base = ctx.baseUrl.replace(/\/+$/, "");
	let url = "";
	let body: Record<string, unknown>;

	switch (ctx.apiMode) {
		case "openai":
			url = `${base}/chat/completions`;
			body = {
				model: ctx.modelId,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				stream: false,
				max_tokens: ctx.maxOutputTokens,
			};
			break;
		case "ollama":
			url = `${base}/api/chat`;
			body = {
				model: ctx.modelId,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				stream: false,
				options: { temperature: 0.2, num_predict: ctx.maxOutputTokens },
			};
			break;
		case "anthropic":
			url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
			body = {
				model: ctx.modelId,
				system,
				messages: [{ role: "user", content: user }],
				max_tokens: ctx.maxOutputTokens,
				stream: false,
			};
			break;
		case "gemini": {
			const geminiUrl = buildGeminiGenerateContentUrl(ctx.baseUrl, ctx.modelId, false);
			if (!geminiUrl) {
				throw new Error("Invalid Gemini base URL configuration.");
			}
			url = geminiUrl;
			body = {
				systemInstruction: { parts: [{ text: system }] },
				contents: [{ role: "user", parts: [{ text: user }] }],
				generationConfig: { maxOutputTokens: ctx.maxOutputTokens },
			};
			break;
		}
		case "openai-responses":
			url = `${base}/responses`;
			body = {
				model: ctx.modelId,
				instructions: system,
				input: user,
				stream: false,
				max_output_tokens: ctx.maxOutputTokens,
			};
			break;
		default:
			throw new Error(`Unsupported API mode for summarization: ${ctx.apiMode}`);
	}

	// The summary request must never offer tools: a tool call inside the
	// summarization call would recurse into an agent loop (Copilot Chat's
	// prompt guards the same way).
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(new Error("Summarization timed out")), SUMMARY_TIMEOUT_MS);
	const cancellationDisposable = ctx.token?.onCancellationRequested(() => {
		abortController.abort(new Error("Request cancelled"));
	});

	try {
		return await executeWithRetry(async () => {
			const res = await fetch(url, {
				method: "POST",
				headers: { ...ctx.headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			if (!res.ok) {
				const errorText = await res.text();
				throw new Error(
					`Summary API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText.slice(0, 500)}` : ""}\nURL: ${url}`
				);
			}

			const data: unknown = await res.json();
			const summary = extractSummary(ctx.apiMode, data).trim();
			if (!summary) {
				throw new Error("Summarization returned an empty result");
			}
			return { summary };
		}, ctx.retryConfig);
	} finally {
		clearTimeout(timeout);
		cancellationDisposable?.dispose();
	}
}

/**
 * Compresses a conversation transcript into a short summary using the user's
 * own model (same endpoint/mode as the main request). Throws on any failure;
 * callers must fall back to hard trimming.
 */
export async function summarizeConversation(
	transcript: string,
	ctx: SummaryRequestContext
): Promise<string> {
	const { system, user } = buildSummaryPrompt(transcript, ctx.summarizationInstructions);
	logger.debug("context.summarize.request", {
		apiMode: ctx.apiMode,
		modelId: ctx.modelId,
		transcriptChars: transcript.length,
	});

	const outcome = await sendSummaryRequest(system, user, ctx);
	const estimatedTokens = await textTokenLength(outcome.summary);
	logger.debug("context.summarize.response", {
		apiMode: ctx.apiMode,
		summaryChars: outcome.summary.length,
		estimatedTokens,
	});
	return outcome.summary;
}
