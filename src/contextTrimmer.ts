import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import { countMessageTokens } from "./provideToken";
import { isToolResultPart, mapRole } from "./utils";

export interface ContextTrimmerModelConfig {
	includeReasoningInRequest: boolean;
}

/**
 * A group of messages that must be kept or dropped together.
 *
 * Tool rounds are atomic: an assistant message carrying tool calls and the
 * user messages carrying the matching tool results are one atom, so trimming
 * can never leave orphaned tool calls or tool results behind (gateways
 * reject both).
 */
export interface MessageAtom {
	/** Indexes into the original messages array, ascending. */
	readonly indexes: number[];
	/** Estimated token count of all messages in this atom. */
	readonly tokens: number;
	/** True for system/developer messages: always kept, never dropped. */
	readonly isSystem: boolean;
}

function hasToolCalls(message: LanguageModelChatRequestMessage): boolean {
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelToolCallPart) {
			return true;
		}
	}
	return false;
}

function hasToolResults(message: LanguageModelChatRequestMessage): boolean {
	for (const part of message.content ?? []) {
		if (isToolResultPart(part)) {
			return true;
		}
	}
	return false;
}

/**
 * Splits a message history into atoms. Ordering matches the input array.
 */
export async function buildMessageAtoms(
	messages: readonly LanguageModelChatRequestMessage[],
	modelConfig: ContextTrimmerModelConfig
): Promise<MessageAtom[]> {
	const atoms: MessageAtom[] = [];
	let i = 0;
	while (i < messages.length) {
		const role = mapRole(messages[i]);
		if (role === "system") {
			atoms.push({
				indexes: [i],
				tokens: await countMessageTokens(messages[i], modelConfig),
				isSystem: true,
			});
			i++;
			continue;
		}
		if (role === "assistant" && hasToolCalls(messages[i])) {
			// Tool round: assistant tool calls + all immediately following
			// tool result messages belong together.
			const indexes = [i];
			let j = i + 1;
			while (j < messages.length && mapRole(messages[j]) === "user" && hasToolResults(messages[j])) {
				indexes.push(j);
				j++;
			}
			let tokens = 0;
			for (const idx of indexes) {
				tokens += await countMessageTokens(messages[idx], modelConfig);
			}
			atoms.push({ indexes, tokens, isSystem: false });
			i = j;
			continue;
		}
		atoms.push({
			indexes: [i],
			tokens: await countMessageTokens(messages[i], modelConfig),
			isSystem: false,
		});
		i++;
	}
	return atoms;
}

/**
 * Turn-aware hard trim: keeps system messages and the most recent turns while
 * the estimated token total fits the budget, dropping whole atoms from the
 * oldest end. Tool rounds are never split. The last atom is always kept even
 * if it alone exceeds the budget.
 */
export async function trimMessagesToBudget(
	messages: readonly LanguageModelChatRequestMessage[],
	budget: number,
	modelConfig: ContextTrimmerModelConfig
): Promise<LanguageModelChatRequestMessage[]> {
	if (messages.length === 0 || budget < 1) {
		return [...messages];
	}

	const atoms = await buildMessageAtoms(messages, modelConfig);
	const totalTokens = atoms.reduce((sum, atom) => sum + atom.tokens, 0);
	if (totalTokens <= budget) {
		return [...messages];
	}

	const keep = new Array<boolean>(atoms.length).fill(false);
	let used = 0;
	for (let i = atoms.length - 1; i >= 0; i--) {
		const atom = atoms[i];
		if (atom.isSystem || i === atoms.length - 1 || used + atom.tokens <= budget) {
			keep[i] = true;
			used += atom.tokens;
		}
	}

	const result: LanguageModelChatRequestMessage[] = [];
	for (let i = 0; i < atoms.length; i++) {
		if (keep[i]) {
			for (const idx of atoms[i].indexes) {
				result.push(messages[idx]);
			}
		}
	}
	return result;
}
