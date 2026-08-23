import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import type { SessionStats } from "./sessionStats";

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = "$(pass-filled) Libiao Copilot 已加载";
	tokenCountStatusBarItem.tooltip = "当前模型 Token 用量 - 点击打开配置界面";
	tokenCountStatusBarItem.command = "libiaoCopilot.openConfig";
	context.subscriptions.push(tokenCountStatusBarItem);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▆ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/** 用量告警阈值（与状态栏底色阈值一致） */
const WARNING_THRESHOLD = 70;
const ERROR_THRESHOLD = 90;

/**
 * 构建状态栏 tooltip（Markdown 排版）：
 * - 上下文用量：消息/工具/合计三行紧凑文本（行尾双空格强制换行，数字等宽 code）；
 * - 合计行按占比加严重度图标（≥70% $(warning)、≥90% $(error)，<70% 无标记）；
 * - 会话统计段追加在空行之后（见 sessionStats.formatTooltip，同为紧凑文本行）；
 * - 说明：不用 Markdown 表格——hover 渲染表格单元格带固定 padding，
 *   每行都被撑开导致行距松散；文本行行距即普通正文行距，紧凑许多；
 * - supportThemeIcons 让 codicon 按主题渲染语义色。
 */
export function buildContextTooltip(
	messagesTokens: number,
	toolTokens: number,
	totalTokenCount: number,
	maxTokens: number,
	sessionStats?: SessionStats
): vscode.MarkdownString {
	const pct = (value: number): string => Math.min((value / maxTokens) * 100, 100).toFixed(1) + "%";
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	let severity = "";
	if (usagePercentage >= ERROR_THRESHOLD) {
		severity = "$(error) ";
	} else if (usagePercentage >= WARNING_THRESHOLD) {
		severity = "$(warning) ";
	}

	// 上下文用量块：行尾双空格强制换行（与 sessionStats 紧凑文本风格一致），
	// 不用 Markdown 表格——hover 渲染表格单元格带固定 padding，行距松散
	const contextLines: string[] = [
		"**$(symbol-parameter) 上下文用量**",
		`消息：\`${formatTokenCount(messagesTokens)}\` · ${pct(messagesTokens)}`,
		`工具：\`${formatTokenCount(toolTokens)}\` · ${pct(toolTokens)}`,
		`${severity}合计：**\`${formatTokenCount(totalTokenCount)}\`** / \`${formatTokenCount(maxTokens)}\` · **${pct(totalTokenCount)}**`,
	];

	// 各块（上下文用量 / 模型统计 / 分隔线）之间用空行分隔
	const parts: string[] = [contextLines.join("  \n")];
	const statsText = sessionStats ? sessionStats.formatTooltip() : "";
	if (statsText) {
		parts.push(statsText);
	}
	parts.push("---", "$(gear) 点击打开配置界面");

	const md = new vscode.MarkdownString(parts.join("\n\n"));
	md.supportThemeIcons = true;
	return md;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean },
	sessionStats?: SessionStats,
	configuredInputTokens?: number
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	// 上限口径：用户选的上下文大小（输入预算 + 输出预留）优先，
	// 未选择时用模型满血上下文兜底。与 contextManager 裁剪预算对齐，
	// 避免用户选了小上下文后百分比被理论最大值稀释、红黄告警永不触发。
	const maxTokens = configuredInputTokens !== undefined
		? configuredInputTokens + model.maxOutputTokens
		: model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	const displayText = `$(pass-filled) Libiao Copilot - ${progressBar}`;
	statusBarItem.text = displayText;
	statusBarItem.tooltip = buildContextTooltip(messagesTokens, toolTokens, totalTokenCount, maxTokens, sessionStats);

	// Add color coding based on token usage
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}
