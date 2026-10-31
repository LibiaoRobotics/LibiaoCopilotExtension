/**
 * 把企微里的一条文字回复，翻译成「提问轮播」的答案。
 *
 * 为什么需要它：vscode_askQuestions 在核心里不是确认框，而是往对话追加一个
 * questionCarousel 进度部件后 await 它的 DeferredPromise，答案只能来自 UI。
 * 用户若在企微里回「1」，这条消息会走正常注入路径，而 chatWidget 发现
 * requestNeedsInput 为真、requestInProgress 为假，就 cancelCurrentRequestForSession
 * 并把轮播 dismiss(undefined) —— 结果是提问被**跳过**、「1」变成一条新的用户消息。
 * 所以必须在注入之前把它拦下，改用内部命令提交答案。
 *
 * 答案格式（全部来自核心源码，改动前先核对）：
 *   - 命令：`_chat.notifyQuestionCarouselAnswer(resolveId, answers)`
 *   - 键：`${resolveId}:${index}`，index 与 hook 里 questions 数组下标一致
 *   - 值：text → 字符串；单选 → {selectedValue}；多选 → {selectedValues}
 *   - 选项值必须是 `label` 原文，不能用带描述的显示文本
 *   - answers 传 undefined 等于全部跳过（工具正常返回，不抛取消）
 */
import type { PendingInteraction, PendingQuestion } from "./wechatBridgeInteractions";

/** 与核心 IChatQuestionAnswers 对应的最小结构 */
export type ChatQuestionAnswerValue =
	| string
	| { selectedValue?: string; freeformValue?: string }
	| { selectedValues: string[]; freeformValue?: string };

export type ChatQuestionAnswers = Record<string, ChatQuestionAnswerValue>;

/** 用户明确表示不想答时的关键词 */
const SKIP_WORDS = new Set(["跳过", "略过", "skip"]);

/**
 * 自定义作答前缀。
 *
 * 故意不用「裸文字就是自定义答案」：提问挂着时用户也可能只是想正常聊一句，
 * 那样会被默默当成答案提交、并把提问关掉。前缀让两种意图各自明确。
 */
const CUSTOM_PREFIX = /^答\s*(\d+)?\s*[:：]?\s*([\s\S]+)$/;

export type AnswerPlan =
	| { kind: "answers"; answers: ChatQuestionAnswers; summary: string }
	| { kind: "skip"; summary: string }
	/** 解析不了：必须把说明回给用户，**绝不能退回注入**，注入会把提问取消掉 */
	| { kind: "hint"; text: string };

function answerKey(interaction: PendingInteraction, question: PendingQuestion): string {
	return `${interaction.resolveId}:${question.index}`;
}

function optionText(question: PendingQuestion, pick: number): string {
	return question.options[pick - 1]?.label ?? "";
}

function questionTitle(question: PendingQuestion, position: number): string {
	return question.header || question.text || `问题 ${position + 1}`;
}

/** 裸文字时的提示：把三种可用回复都摆出来，免得用户猜 */
function customHint(question: PendingQuestion, position: number): string {
	return [
		`「${questionTitle(question, position)}」还在等你选。`,
		`回编号作答（1~${question.options.length}），或者发「答 你的内容」自定义作答，回「跳过」略过。`,
	].join("");
}

/** 只认「1」「1 2」「1,2」，避免把普通句子里的数字当成选项 */
function readPicks(text: string): number[] | undefined {
	if (!/^\d+(?:\s*[,，、\s]\s*\d+)*$/.test(text)) {
		return undefined;
	}
	return text.split(/[\s,，、]+/).filter(Boolean).map((token) => Number(token));
}

function outOfRange(question: PendingQuestion, picks: number[]): boolean {
	return picks.some((pick) => pick < 1 || pick > question.options.length);
}

/**
 * 解析一条回复。返回 hint 时调用方必须把文字回给用户，且不得注入对话。
 */
export function planQuestionAnswers(interaction: PendingInteraction, message: string): AnswerPlan {
	const text = message.trim();
	const questions = interaction.questions;
	if (questions.length === 0) {
		// sidecar 里没有可作答的问题（例如只有 header）：只能回电脑
		return { kind: "hint", text: "这条提问没有可选项，请回到 VS Code 里处理。" };
	}
	if (SKIP_WORDS.has(text.toLowerCase())) {
		return { kind: "skip", summary: "已跳过这次提问，我继续往下走。" };
	}
	const picks = readPicks(text);
	const custom = CUSTOM_PREFIX.exec(text);

	if (questions.length === 1) {
		const question = questions[0];
		if (question.options.length === 0) {
			// 纯文本题：本来就只有输入框，整条消息就是答案，不再要求前缀
			return {
				kind: "answers",
				answers: { [answerKey(interaction, question)]: custom ? custom[2].trim() : text },
				summary: `已提交「${questionTitle(question, 0)}」：${custom ? custom[2].trim() : text}`,
			};
		}
		if (picks) {
			if (outOfRange(question, picks)) {
				return {
					kind: "hint",
					text: `「${questionTitle(question, 0)}」只有 1~${question.options.length} 这几项可选，请重新回复编号。`,
				};
			}
			if (question.multiSelect) {
				const selectedValues = picks.map((pick) => optionText(question, pick));
				return {
					kind: "answers",
					answers: { [answerKey(interaction, question)]: { selectedValues } },
					summary: `已提交「${questionTitle(question, 0)}」：${selectedValues.join("、")}`,
				};
			}
			if (picks.length > 1) {
				return {
					kind: "hint",
					text: `「${questionTitle(question, 0)}」是单选题，请只回一个编号（1~${question.options.length}）。`,
				};
			}
			const selectedValue = optionText(question, picks[0]);
			return {
				kind: "answers",
				answers: { [answerKey(interaction, question)]: { selectedValue } },
				summary: `已提交「${questionTitle(question, 0)}」：${selectedValue}`,
			};
		}
		if (custom) {
			const freeformValue = custom[2].trim();
			return {
				kind: "answers",
				answers: { [answerKey(interaction, question)]: { freeformValue } },
				summary: `已提交自定义作答：${freeformValue}`,
			};
		}
		// 裸文字不当答案：否则用户想聊一句就把提问答掉了
		return { kind: "hint", text: customHint(question, 0) };
	}

	// 多个问题：同一份轮播只能提交一次，必须一次给全，避免把编号错位到别的问题上
	if (!picks) {
		return {
			kind: "hint",
			text: `这条提问有 ${questions.length} 个问题，请按顺序回复 ${questions.length} 个编号（如 \`${questions.map(() => "1").join(" ")}\`），或回「跳过」。`,
		};
	}
	if (questions.some((question) => question.multiSelect)) {
		return { kind: "hint", text: "这条提问含多选题，请回到 VS Code 里点选。" };
	}
	if (picks.length !== questions.length) {
		return {
			kind: "hint",
			text: `这条提问有 ${questions.length} 个问题，你回了 ${picks.length} 个编号，请按顺序补全（如 \`${questions.map(() => "1").join(" ")}\`）。`,
		};
	}
	const parts: string[] = [];
	const answers: ChatQuestionAnswers = {};
	for (let position = 0; position < questions.length; position += 1) {
		const question = questions[position];
		const pick = picks[position];
		if (question.options.length === 0) {
			return { kind: "hint", text: "这条提问含文本题，请回到 VS Code 里作答。" };
		}
		if (outOfRange(question, [pick])) {
			return {
				kind: "hint",
				text: `第 ${position + 1} 个问题只有 1~${question.options.length} 这几项可选，请重新回复。`,
			};
		}
		const selectedValue = optionText(question, pick);
		answers[answerKey(interaction, question)] = { selectedValue };
		parts.push(`${questionTitle(question, position)} → ${selectedValue}`);
	}
	return { kind: "answers", answers, summary: `已提交：${parts.join("；")}` };
}
