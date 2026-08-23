import { logger } from "./logger";

/**
 * 会话级生成性能统计模块。
 *
 * 设计要点（2026-08-22，替代原实时 TPS 估算方案）：
 * - 实时估算不准（字符/token 换算系数对思考内容高估 2 倍以上），已弃用；
 * - 本模块只累计服务端返回的精确 usage（completion_tokens），不参与任何估算；
 * - 统计维度：请求数、总输出 token（思考+正文）、思考 token、累计流式耗时、平均 TPS；
 * - 流式耗时 = 首个非空 delta → 最后一个非空 delta（含思考阶段，真实生成时间）；
 * 统计按模型组合 ID（id::configId）独立累计，不随会话切换自动重置——
 * 原“消息条数骤降”会话边界启发式在多个会话并存时误判误清空，已移除（2026-08-23）。
 */

/** 模型级统计结果 */
export interface SessionStatsEntry {
	/** 模型组合 ID（id::configId） */
	modelId: string;
	/** 显示名（displayName，可能带视觉图标 emoji 前缀；未记录时回退 modelId） */
	displayName?: string;
	/** 成功计入统计的请求数 */
	requests: number;
	/** 总输出 token（思考 + 正文，服务端精确值） */
	outputTokens: number;
	/** 思考 token（服务端 reasoning_tokens，可能拿不到） */
	reasoningTokens: number;
	/** 累计流式耗时（ms，首 delta → 末 delta） */
	totalStreamMs: number;
}

/**
 * 会话级统计上下文（按模型分别累计）。
 */
export class SessionStats {
	/** modelId → 统计数据 */
	private _byModel = new Map<string, SessionStatsEntry>();

	/**
	 * 记录一次请求的精确用量。
	 * @param modelId 模型组合 ID（id::configId，统计键）
	 * @param usage 服务端 usage（completion_tokens 为 0 或缺失时忽略）
	 * @param streamMs 流式耗时（首 delta → 末 delta，毫秒；<=0 或缺失时不算入累计耗时）
	 * @param displayName 显示名（displayName 优先，可能带视觉图标；配置改名后以最新为准）
	 */
	recordRequest(modelId: string, usage: { completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } } | null | undefined, streamMs: number | null | undefined, displayName?: string): void {
		if (!usage || !usage.completion_tokens || usage.completion_tokens <= 0) {
			// 网关未回 usage 或 token 为 0：本次请求无法精确统计，跳过
			logger.debug("sessionStats.skip", { modelId, reason: "no_usage" });
			return;
		}
		let entry = this._byModel.get(modelId);
		if (!entry) {
			entry = {
				modelId,
				displayName,
				requests: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				totalStreamMs: 0,
			};
			this._byModel.set(modelId, entry);
		} else if (displayName !== undefined && displayName !== entry.displayName) {
			// 用户改了 displayName 配置：保持显示最新名字
			entry.displayName = displayName;
		}
		entry.requests += 1;
		entry.outputTokens += usage.completion_tokens;
		entry.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
		if (streamMs && streamMs > 0) {
			entry.totalStreamMs += streamMs;
		}
		logger.debug("sessionStats.record", { modelId, entry });
	}

	/**
	 * 清空所有统计（新会话检测触发）。
	 */
	reset(): void {
		this._byModel.clear();
		logger.debug("sessionStats.reset", {});
	}

	/**
	 * 获取指定模型的统计（无记录返回 null）。
	 */
	get(modelId: string): SessionStatsEntry | null {
		return this._byModel.get(modelId) ?? null;
	}

	/**
	 * 生成 tooltip 追加段落（紧凑文本行；多模型时按各自统计展示，块间空一行）。
	 * 消费方（statusBar.buildContextTooltip）会将结果包进 MarkdownString。
	 */
	formatTooltip(): string {
		if (this._byModel.size === 0) {
			return "";
		}
		const blocks: string[] = [];
		for (const entry of this._byModel.values()) {
			blocks.push(this._formatEntry(entry));
		}
		return blocks.join("\n\n");
	}

	/**
	 * 格式化单个模型的统计（紧凑文本行，行尾双空格强制换行）。
	 * 数值用 code span（等宽对齐）；平均速度行用 $(info) 蓝色主题图标突出展示。
	 * 说明：不用 Markdown 表格——hover 渲染表格单元格带固定 padding，
	 * 每行都被撑开导致行距松散；文本行行距即普通正文行距，紧凑许多。
	 */
	private _formatEntry(entry: SessionStatsEntry): string {
		const avgTps = entry.totalStreamMs > 0
			? ((entry.outputTokens / entry.totalStreamMs) * 1000).toFixed(0)
			: "N/A";
		const reasoningPct = entry.outputTokens > 0
			? Math.round((entry.reasoningTokens / entry.outputTokens) * 100)
			: 0;
		// 显示名：displayName（带视觉图标）优先，缺失时回退 modelId
		const label = entry.displayName || entry.modelId;
		const lines: string[] = [
			`**$(graph) 模型统计 · ${label}**`,
			`请求次数：\`${this._formatNumber(entry.requests)}\``,
			`输出 token：\`${this._formatNumber(entry.outputTokens)}\``,
		];
		if (entry.reasoningTokens > 0) {
			const visibleTokens = entry.outputTokens - entry.reasoningTokens;
			lines.push(`├ 思考（${reasoningPct}%）：\`${this._formatNumber(entry.reasoningTokens)}\``);
			lines.push(`└ 正文（${100 - reasoningPct}%）：\`${this._formatNumber(visibleTokens)}\``);
		}
		lines.push(`流式耗时：${this._formatDuration(entry.totalStreamMs)}`);
		lines.push(`$(info) 平均速度：**${avgTps}** token/秒`);
		return lines.join("  \n");
	}

	/**
	 * 毫秒数转中文可读时长（<1s 毫秒、>=60s 分秒、其余取整秒）。
	 */
	private _formatDuration(ms: number): string {
		if (ms < 1000) {
			return `${Math.round(ms)} 毫秒`;
		}
		const sec = ms / 1000;
		if (sec >= 60) {
			const m = Math.floor(sec / 60);
			const s = Math.round(sec % 60);
			return `${m} 分 ${s} 秒`;
		}
		return `${sec.toFixed(0)} 秒`;
	}

	/**
	 * 数字格式化（千分位）。
	 */
	private _formatNumber(value: number): string {
		return value.toLocaleString("en-US");
	}
}
