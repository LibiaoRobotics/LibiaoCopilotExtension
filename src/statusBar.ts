import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import type { SessionStats } from "./sessionStats";
import type { WechatNotifyConfigState } from "./wechatNotifyConfig";
import {
	resolveWechatNotifyStatus,
	type WechatNotifyHookPresence,
	type WechatNotifyScriptInfo,
	type WechatNotifyStatus,
} from "./wechatNotifyHookSetup";
import {
	WECHAT_NOTIFY_JSON_FILE_NAME,
	WECHAT_NOTIFY_SCRIPT_FILE_NAME,
} from "./wechatNotifyPaths";

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
 * 企微联动图标。priority 小于 Token Count 的 100 —— 该值越大越靠左，
 * 因此 99 才会排在 Token Count 右侧。
 */
export function initWechatNotifyStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	const wechatNotifyStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	wechatNotifyStatusBarItem.name = "企微联动";
	wechatNotifyStatusBarItem.text = "$(broadcast) 企微联动";
	wechatNotifyStatusBarItem.tooltip = "企微联动 - 点击打开配置界面";
	wechatNotifyStatusBarItem.command = "libiaoCopilot.openWechatNotifyConfig";
	context.subscriptions.push(wechatNotifyStatusBarItem);
	wechatNotifyStatusBarItem.show();
	return wechatNotifyStatusBarItem;
}

/**
 * 主状态 → 图标。$(warning) 只留给"配了但发不出去"的故障态。
 *
 * 未创建用 $(broadcast) 而非空心圆：圆圈是零语义符号，读不出功能也不出状态；
 * broadcast 的外扩弧线直指"往外推送"这个动作，与已启用的 $(bell) 成族但形状差异大，
 * 小尺寸下不会和 $(bell-slash) 互相混淆。也不用 $(circle-slash)：禁用符会让人以为功能坏了。
 */
const WECHAT_NOTIFY_STATUS_ICON: Record<WechatNotifyStatus, string> = {
	active: "$(bell)",
	disabled: "$(bell-slash)",
	"not-created": "$(broadcast)",
	"no-workspace": "$(circle-slash)",
	incomplete: "$(warning)",
};

/** 主状态 → tooltip 首行文案，补足图标表达不了的细节 */
const WECHAT_NOTIFY_STATUS_TEXT: Record<WechatNotifyStatus, string> = {
	active: "已启用，通知会正常发送",
	disabled: "未启用，不会发送通知",
	"not-created": "当前项目尚未创建，点开面板可一键初始化",
	incomplete: "hook 文件不完整，通知不会触发",
	"no-workspace": "未打开工作区，无法联动",
};

/** 勾了启用却没填 webhook 时按未启用处理，这里说清是为什么，免得用户以为开关失灵 */
function describeStatus(status: WechatNotifyStatus, webhookConfigured: boolean): string {
	if (status === "disabled" && !webhookConfigured) {
		return "未启用（Webhook 为空，按未启用处理），不会发送通知";
	}
	return WECHAT_NOTIFY_STATUS_TEXT[status];
}

/**
 * 这些状态用灰色图标，避免和真正需要处理的故障抢注意力。
 *
 * not-created 不在其中：灰色 + 禁用符的双重否定会读成"功能失效"，
 * 而它其实是可一键初始化的正常起点，用正常前景色即可。
 */
const WECHAT_NOTIFY_DIM_STATUS: ReadonlySet<WechatNotifyStatus> = new Set<WechatNotifyStatus>([
	"disabled",
	"no-workspace",
]);

/**
 * 用当前配置刷新图标。
 *
 * 这里不探测 pwsh —— 探测要 spawn 进程且未安装时吃满超时，状态栏刷新频率高，
 * 只依据文件存在性与脚本版本（廉价读文件）。
 *
 * 主状态互斥决定图标；"待升级"是叠加标记，只用箭头后缀 + tooltip 提示，
 * 不算故障，不抢 $(warning) 的语义。
 *
 * workspaceReady 不传时按 configPath 推断：配置文件路径拿不到就说明没打开工作区。
 */
export function updateWechatNotifyStatusBar(
	item: vscode.StatusBarItem,
	state: WechatNotifyConfigState,
	presence?: WechatNotifyHookPresence,
	script?: WechatNotifyScriptInfo,
	workspaceReady = state.configPath !== undefined
): void {
	const { settings, exists, configPath } = state;
	const webhookConfigured = settings.webhook.trim().length > 0;

	// 未传 presence 的旧调用按"文件齐备"处理，保持降级行为不变
	const currentPresence: WechatNotifyHookPresence = presence ?? { json: true, script: true, config: true };
	const missingHookFiles: string[] = [];
	if (presence) {
		if (!presence.json) {
			missingHookFiles.push(WECHAT_NOTIFY_JSON_FILE_NAME);
		}
		if (!presence.script) {
			missingHookFiles.push(WECHAT_NOTIFY_SCRIPT_FILE_NAME);
		}
	}

	const status = resolveWechatNotifyStatus({
		workspaceReady,
		presence: currentPresence,
		enabled: settings.enabled,
		webhook: settings.webhook,
	});
	// 只有真正在用的状态才叠升级标记：故障态已经占了 $(warning)，再叠箭头只会让两种信号互相干扰
	const scriptMarkable = status === "active" || status === "disabled";
	const scriptPending =
		scriptMarkable && (script?.status === "outdated" || script?.status === "unknown");

	const icon = WECHAT_NOTIFY_STATUS_ICON[status];
	// not-created 的图标不带状态色，文字必须自己说清"还没接上"，否则读起来像已生效。
	const label = status === "not-created" ? "企微未联动" : "企微联动";
	item.text = scriptPending ? `${icon} ${label} $(arrow-up)` : `${icon} ${label}`;
	item.color = WECHAT_NOTIFY_DIM_STATUS.has(status)
		? new vscode.ThemeColor("disabledForeground")
		: undefined;

	const configPathText = configPath ? `\`${configPath}\`` : "未打开工作区";
	const configFileLine = `配置文件：${configPathText}${exists ? "" : "（不存在，使用默认值）"}`;
	const hookLine = missingHookFiles.length === 0
		? presence
			? "Hook：已就绪"
			: undefined
		: `Hook：缺少 ${missingHookFiles.join("、")}，通知不会触发`;
	const scriptLine = !scriptMarkable || !script
		? undefined
		: script.status === "outdated"
			? `脚本：${script.installedVersion} → ${script.templateVersion}，可在面板点「更新脚本」`
			: script.status === "unknown"
				? "脚本：未检测到版本号，可能是旧版，可在面板点「更新脚本」"
				: script.identical
					? undefined
					: `脚本：${script.installedVersion}（已是最新，含你的本地修改）`;
	const tooltip = new vscode.MarkdownString(
		[
			`$(bell) **企微联动** — ${describeStatus(status, webhookConfigured)}`,
			`Webhook：${webhookConfigured ? "已配置" : "未配置"}  `,
			hookLine ? `${hookLine}  ` : undefined,
			scriptLine ? `${scriptLine}  ` : undefined,
			`最小耗时：${settings.minDurationSeconds} 秒  `,
			`摘要字数：${settings.sessionSummaryChars} 字  `,
			configFileLine + "  ",
			"",
			"$(gear) 点击打开配置界面",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n")
	);
	tooltip.supportThemeIcons = true;
	item.tooltip = tooltip;
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
	const displayText = `$(pass-filled) Libiao Copilot ${progressBar}`;
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
