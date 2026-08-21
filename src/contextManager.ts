import * as vscode from "vscode";
import type { CancellationToken, LanguageModelChatRequestMessage } from "vscode";
import { getConfiguredContextSize } from "./modelConfiguration";
import { buildMessageAtoms, trimMessagesToBudget, type ContextTrimmerModelConfig } from "./contextTrimmer";
import { buildConversationTranscript, summarizeConversation, type SummaryRequestContext } from "./contextSummarizer";
import { countMessageTokens } from "./provideToken";
import { logger } from "./logger";
import type { HFApiMode, RetryConfig } from "./types";

export type ContextManagementMode = "off" | "summarize";

/**
 * Copilot Chat applies its context budget at 90% of the model's prompt
 * window; we mirror that so token-count estimation drift never overshoots.
 */
export const CONTEXT_BUDGET_SAFETY_FACTOR = 0.9;

export interface ContextCompactionInfo {
	mode: "summarize" | "trim";
	reason: "budget_exceeded" | "summarize_failed" | "still_over_budget";
	beforeTokens: number;
	afterTokens: number;
	beforeCount: number;
	afterCount: number;
	durationMs: number;
}

export interface ContextManagerContext {
	apiMode: HFApiMode;
	baseUrl: string;
	modelId: string;
	apiKey: string;
	headers: Record<string, string>;
	retryConfig: RetryConfig;
	modelConfig: ContextTrimmerModelConfig;
	mode: ContextManagementMode;
	summarizationInstructions: string;
	summarizeMaxTokens: number;
	token?: CancellationToken;
}

async function totalTokens(
	messages: readonly LanguageModelChatRequestMessage[],
	modelConfig: ContextTrimmerModelConfig
): Promise<number> {
	let total = 0;
	for (const message of messages) {
		total += await countMessageTokens(message, modelConfig);
	}
	return total;
}

/**
 * Summarize path: keep the most recent turns as raw messages and replace the
 * older ones with a single summary message (system role, so it survives in
 * every API mode without breaking user/assistant alternation). Returns null
 * when there is nothing worth summarizing — the caller should hard trim.
 */
async function trySummarize(
	messages: readonly LanguageModelChatRequestMessage[],
	budget: number,
	ctx: ContextManagerContext
): Promise<LanguageModelChatRequestMessage[] | null> {
	const atoms = await buildMessageAtoms(messages, ctx.modelConfig);
	const systemMessages: LanguageModelChatRequestMessage[] = [];
	const nonSystemAtoms: typeof atoms = [];
	for (const atom of atoms) {
		if (atom.isSystem) {
			for (const idx of atom.indexes) {
				systemMessages.push(messages[idx]);
			}
		} else {
			nonSystemAtoms.push(atom);
		}
	}
	if (nonSystemAtoms.length === 0) {
		return null;
	}

	// Reserve room for the summary text itself (plus counting drift): recent
	// turns may use at most `budget - summaryReserve` tokens. The configured
	// value is clamped to the settings schema bounds — a hand-edited
	// settings.json may hold out-of-range values that gateways would reject.
	const maxSummaryTokens = Math.max(256, Math.min(ctx.summarizeMaxTokens, 32768));
	const summaryReserve = Math.max(256, Math.min(maxSummaryTokens, Math.floor(budget * 0.3)));
	const keep = new Array<boolean>(nonSystemAtoms.length).fill(false);
	let keptTokens = 0;
	for (let i = nonSystemAtoms.length - 1; i >= 0; i--) {
		const atom = nonSystemAtoms[i];
		if (i === nonSystemAtoms.length - 1 || keptTokens + atom.tokens <= budget - summaryReserve) {
			keep[i] = true;
			keptTokens += atom.tokens;
		}
	}

	const keptMessages: LanguageModelChatRequestMessage[] = [];
	const summaryWindow: LanguageModelChatRequestMessage[] = [];
	for (let i = 0; i < nonSystemAtoms.length; i++) {
		const target = keep[i] ? keptMessages : summaryWindow;
		for (const idx of nonSystemAtoms[i].indexes) {
			target.push(messages[idx]);
		}
	}
	// Nothing worth summarizing: no older messages at all, or only a single
	// one. Compressing one message into one summary message neither reduces
	// the message count nor saves a meaningful amount of tokens, but still
	// costs a full model call — fall back to silent hard trimming instead.
	if (summaryWindow.length <= 1) {
		return null;
	}

	const transcript = buildConversationTranscript(summaryWindow);
	const summaryContext: SummaryRequestContext = {
		apiMode: ctx.apiMode,
		baseUrl: ctx.baseUrl,
		modelId: ctx.modelId,
		apiKey: ctx.apiKey,
		headers: ctx.headers,
		retryConfig: ctx.retryConfig,
		summarizationInstructions: ctx.summarizationInstructions,
		maxOutputTokens: maxSummaryTokens,
		token: ctx.token,
	};

	let summary: string;
	try {
		summary = await summarizeConversation(transcript, summaryContext);
	} catch (err) {
		logger.warn("context.summarize.failed", {
			modelId: ctx.modelId,
			apiMode: ctx.apiMode,
			errorMessage: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	const summaryMessage: LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.System,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(summary)],
	};

	return [...systemMessages, summaryMessage, ...keptMessages];
}

export interface ManageContextResult {
	messages: LanguageModelChatRequestMessage[];
	compaction?: ContextCompactionInfo;
}

/**
 * Entry point for request-time context management.
 *
 * Honors the context size selected in the VS Code Configure menu (VS Code
 * itself only reports the value — it never trims history). When the message
 * history exceeds the budget:
 *   - "summarize": compress the older turns into a summary message; falls
 *     back to hard trimming when summarization fails or is still over budget.
 *   - "off": send the history unchanged.
 *
 * Without a selected context size nothing is touched.
 */
export async function manageContext(
	messages: readonly LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions,
	ctx: ContextManagerContext
): Promise<ManageContextResult> {
	if (ctx.mode === "off" || messages.length === 0) {
		return { messages: [...messages] };
	}

	const configuredSize = getConfiguredContextSize(options);
	if (!configuredSize) {
		return { messages: [...messages] };
	}

	const budget = Math.floor(configuredSize * CONTEXT_BUDGET_SAFETY_FACTOR);
	if (budget < 1) {
		return { messages: [...messages] };
	}

	const beforeTokens = await totalTokens(messages, ctx.modelConfig);
	if (beforeTokens <= budget) {
		return { messages: [...messages] };
	}

	const startedAt = Date.now();
	let result: LanguageModelChatRequestMessage[];
	let info: ContextCompactionInfo;

	if (ctx.mode === "summarize") {
		const summarized = await trySummarize(messages, budget, ctx);
		if (summarized) {
			const afterSummarizeTokens = await totalTokens(summarized, ctx.modelConfig);
			if (afterSummarizeTokens <= budget) {
				result = summarized;
				info = {
					mode: "summarize",
					reason: "budget_exceeded",
					beforeTokens,
					afterTokens: afterSummarizeTokens,
					beforeCount: messages.length,
					afterCount: summarized.length,
					durationMs: Date.now() - startedAt,
				};
			} else {
				const trimmed = await trimMessagesToBudget(summarized, budget, ctx.modelConfig);
				const afterTokens = await totalTokens(trimmed, ctx.modelConfig);
				result = trimmed;
				info = {
					mode: "trim",
					reason: "still_over_budget",
					beforeTokens,
					afterTokens,
					beforeCount: messages.length,
					afterCount: trimmed.length,
					durationMs: Date.now() - startedAt,
				};
			}
		} else {
			const trimmed = await trimMessagesToBudget(messages, budget, ctx.modelConfig);
			const afterTokens = await totalTokens(trimmed, ctx.modelConfig);
			result = trimmed;
			info = {
				mode: "trim",
				reason: "summarize_failed",
				beforeTokens,
				afterTokens,
				beforeCount: messages.length,
				afterCount: trimmed.length,
				durationMs: Date.now() - startedAt,
			};
		}
	} else {
		const trimmed = await trimMessagesToBudget(messages, budget, ctx.modelConfig);
		const afterTokens = await totalTokens(trimmed, ctx.modelConfig);
		result = trimmed;
		info = {
			mode: "trim",
			reason: "budget_exceeded",
			beforeTokens,
			afterTokens,
			beforeCount: messages.length,
			afterCount: trimmed.length,
			durationMs: Date.now() - startedAt,
		};
	}

	logger.info("context.compacted", {
		modelId: ctx.modelId,
		mode: info.mode,
		reason: info.reason,
		beforeTokens: info.beforeTokens,
		afterTokens: info.afterTokens,
		beforeCount: info.beforeCount,
		afterCount: info.afterCount,
		durationMs: info.durationMs,
	});

	// Only announce successful summarization — hard trimming is a silent
	// fallback that repeats on every request until the history shrinks, so
	// notifying for it would spam the user. Both paths stay visible in the
	// `context.compacted` log event.
	if (info.mode === "summarize") {
		void vscode.window.showInformationMessage(
			`Context compacted: summarized ${info.beforeCount} messages into ${info.afterCount}.`
		);
	}

	return { messages: result, compaction: info };
}
