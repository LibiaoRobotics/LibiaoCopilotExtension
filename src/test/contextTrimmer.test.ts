import * as assert from "assert";
import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import { buildMessageAtoms, trimMessagesToBudget } from "../contextTrimmer";

suite("contextTrimmer", () => {
	const modelConfig = { includeReasoningInRequest: false };

	// Varied English text so the tokenizer estimate is realistic (repetitive
	// strings would compress artificially).
	const LONG_TEXT = "The quick brown fox jumps over the lazy dog near the river bank. ".repeat(300);

	const system = (text: string): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.System,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});

	const user = (text: string): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});

	const assistant = (text: string): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.Assistant,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});

	const toolCall = (callId: string, name: string): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.Assistant,
		name: undefined,
		content: [new vscode.LanguageModelToolCallPart(callId, name, { filePath: "/src/a.ts" })],
	});

	const toolResult = (callId: string, text: string): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)])],
	});

	test("returns messages unchanged when the history fits the budget", async () => {
		const messages = [system("You are helpful."), user("Hello"), assistant("Hi there!")];
		const result = await trimMessagesToBudget(messages, 10_000, modelConfig);
		assert.deepStrictEqual(result, messages);
	});

	test("keeps system messages and drops the oldest turns first", async () => {
		const messages = [
			system("You are helpful."),
			user(`first ${LONG_TEXT}`),
			assistant(`second ${LONG_TEXT}`),
			user(`third ${LONG_TEXT}`),
		];
		// Budget fits roughly one long message plus the system prompt.
		const result = await trimMessagesToBudget(messages, 2_200, modelConfig);
		assert.deepStrictEqual(result[0], messages[0], "system message must be kept");
		assert.deepStrictEqual(result[result.length - 1], messages[3], "last user message must be kept");
		assert.ok(!result.includes(messages[1]), "oldest user turn must be dropped");
		assert.ok(!result.includes(messages[2]), "old assistant turn must be dropped");
	});

	test("keeps the last atom even when it alone exceeds the budget", async () => {
		const messages = [system("You are helpful."), user(`old ${LONG_TEXT}`), user(LONG_TEXT + LONG_TEXT)];
		const result = await trimMessagesToBudget(messages, 500, modelConfig);
		assert.deepStrictEqual(result[0], messages[0]);
		assert.deepStrictEqual(result[1], messages[2], "last message survives regardless of budget");
		assert.ok(!result.includes(messages[1]));
	});

	test("groups tool calls with their results into one atom", async () => {
		const messages = [
			system("You are helpful."),
			user("Read the file."),
			toolCall("call-1", "read_file"),
			toolResult("call-1", `content ${LONG_TEXT}`),
			user("Now summarize."),
		];
		const atoms = await buildMessageAtoms(messages, modelConfig);
		assert.strictEqual(atoms.length, 4);
		assert.deepStrictEqual(atoms[2].indexes, [2, 3], "tool call and result must share one atom");
	});

	test("drops a whole tool round without leaving orphaned calls or results", async () => {
		const messages = [
			system("You are helpful."),
			user(`read ${LONG_TEXT}`),
			toolCall("call-1", "read_file"),
			toolResult("call-1", `result ${LONG_TEXT}`),
			user("Now summarize."),
		];
		// Budget keeps system + last user only: the tool round must vanish entirely.
		const result = await trimMessagesToBudget(messages, 2_000, modelConfig);
		assert.ok(result.includes(messages[0]), "system kept");
		assert.ok(result.includes(messages[4]), "last user kept");
		assert.ok(!result.includes(messages[2]), "tool call dropped");
		assert.ok(!result.includes(messages[3]), "tool result dropped with its call");
	});

	test("keeps a tool round intact when the budget allows it", async () => {
		const messages = [
			system("You are helpful."),
			user(`read ${LONG_TEXT}`),
			toolCall("call-1", "read_file"),
			toolResult("call-1", "result"),
			user("Now summarize."),
		];
		// Budget fits the tool round (result is small) plus the last message.
		const result = await trimMessagesToBudget(messages, 3_000, modelConfig);
		assert.ok(result.includes(messages[2]), "tool call kept");
		assert.ok(result.includes(messages[3]), "tool result kept");
		assert.strictEqual(result.indexOf(messages[2]) + 1, result.indexOf(messages[3]), "pair stays adjacent");
	});
});
