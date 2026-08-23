import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import type { SessionStats } from "./sessionStats";

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = "$(symbol-numeric) Ready";
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
 * 构建状态栏 tooltip（Markdown 表格排版）：
 * - 上下文用量表：消息/工具/合计三行，数字列右对齐 + 等宽 code 字体；
 * - 合计行按占比加严重度图标（≥70% $(warning)、≥90% $(error)，<70% 无标记）；
 * - 会话统计段追加在空行之后（见 sessionStats.formatTooltip）；
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

	const lines: string[] = [
		"**$(symbol-parameter) 上下文用量**",
		"",
		"| 组成 | Token | 占比 |",
		"| :-- | --: | --: |",
		`| 消息 | \`${formatTokenCount(messagesTokens)}\` | ${pct(messagesTokens)} |`,
		`| 工具 | \`${formatTokenCount(toolTokens)}\` | ${pct(toolTokens)} |`,
		`| ${severity}**合计** | **\`${formatTokenCount(totalTokenCount)}\`** / \`${formatTokenCount(maxTokens)}\` | **${pct(totalTokenCount)}** |`,
	];

	const statsText = sessionStats ? sessionStats.formatTooltip() : "";
	if (statsText) {
		lines.push("", statsText);
	}

	lines.push("", "---", "$(gear) 点击打开配置界面");

	const md = new vscode.MarkdownString(lines.join("\n"));
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
	const displayText = `$(symbol-parameter) ${progressBar}`;
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
