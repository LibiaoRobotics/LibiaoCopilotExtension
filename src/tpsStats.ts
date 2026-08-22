import { LanguageModelResponsePart2 } from "vscode";
import { logger } from "./logger";

/**
 * TPS（Tokens Per Second）实时统计模块。
 *
 * 设计要点（2026-08-22）：
 * - 流式过程中拿不到服务端 token 数，用「字符数 × 校准系数」估算；
 * - 校准系数 = 该模型历史请求的 completion_tokens / 字符数 的指数滑动均值，
 *   首个请求用默认值（2.5 字符/token ≈ 中英混合），之后自动收敛；
 * - 结算值 = 服务端 completion_tokens ÷ 流式时长（末个非空 delta - 首个非空 delta），
 *   任何估算都不参与结算；
 * - 停顿检测：超过阈值无非空 delta → 标记停滞。
 */

/** 实时速度的滑动时间窗（毫秒） */
export const TPS_WINDOW_MS = 2000;

/** 停顿判定阈值（毫秒） */
export const STALL_THRESHOLD_MS = 3000;

/** 默认字符/token 换算比（中英混合的粗略值） */
export const DEFAULT_CHARS_PER_TOKEN = 2.5;

/** 校准系数 EMA 平滑因子（0~1，越大越看重新样本） */
export const CALIBRATION_EMA_ALPHA = 0.3;

/** 实测校准比率的最小置信样本数，超过才认为可信 */
export const MIN_CALIBRATION_SAMPLES = 3;

/**
 * 单次请求的实时统计上下文。
 * 由 provider.ts 创建，流式期间逐 chunk 更新，结束时结算。
 */
export class TpsTracker {
	/** 模型 ID（用于日志、分组） */
	readonly modelId: string;

	/** 响应头到达时刻（fetch resolve 时间，请求真正开始） */
	private _streamStartMs = 0;

	/** 首个非空文本/思考 delta 时刻，null = 尚未收到 */
	private _firstDeltaMs: number | null = null;

	/** 最近一次非空 delta 时刻（结算用） */
	private _lastDeltaMs: number | null = null;

	/** 2 秒窗内数据（时间戳 + 字符数，环形缓冲） */
	private _windowChunks: { t: number; chars: number }[] = [];

	/** 本次请求累计输出字符数（文本 + 思考） */
	private _totalChars = 0;

	/** 是否检测到停滞（超过阈值无非空 delta） */
	private _stalled = false;

	/** 是否可判定为「假流式」（只有 done 一次性输出） */
	private _isBurstOnly = true;

	/** 停顿检测定时器 */
	private _stallTimer: ReturnType<typeof setTimeout> | null = null;

	/** 实时估算回调：每次有非空 delta 时被调用，传入当前估算 TPS */
	private _onEstimate: ((tps: number) => void) | null = null;

	/** 停滞回调 */
	private _onStall: ((stalled: boolean) => void) | null = null;

	/** 流结束回调（结算后调用） */
	private _onDone: ((result: RequestTpsResult) => void) | null = null;

	/** 时钟源（测试注入） */
	private readonly _now: () => number;

	constructor(modelId: string, streamStartMs: number, nowFn: () => number = Date.now) {
		this.modelId = modelId;
		this._streamStartMs = streamStartMs;
		this._now = nowFn;
		// 创建即启动停顿检测（请求发出后模型迟迟不吐字也记为停滞）
		this._resetStallWatch();
	}

	/**
	 * 真正的开始点：响应头到达。之后才开始计时（可选，默认构造时即开始）。
	 */
	startStream(): void {
		this._streamStartMs = this._now();
		this._resetStallWatch();
	}

	/**
	 * 注册实时估算回调（如状态栏刷新）。
	 */
	onEstimate(cb: (tps: number) => void): void {
		this._onEstimate = cb;
	}

	/**
	 * 注册停滞回调。
	 */
	onStall(cb: (stalled: boolean) => void): void {
		this._onStall = cb;
	}

	/**
	 * 注册结束回调（流完成/中断时调用）。
	 */
	onDone(cb: (result: RequestTpsResult) => void): void {
		this._onDone = cb;
	}

	/**
	 * 记录一次非空输出（文本或思考），由 trackingProgress 统一调用。
	 * @param chars 本次 delta 的字符数（>0）
	 */
	recordDelta(text: string): void {
		if (!text) {
			return;
		}
		const chars = text.length;
		const now = this._now();

		if (this._firstDeltaMs === null) {
			this._firstDeltaMs = now;
		}
		this._lastDeltaMs = now;
		this._totalChars += chars;
		this._windowChunks.push({ t: now, chars });
		this._isBurstOnly = false;
		this._stalled = false;
		this._resetStallWatch();

		// 触发实时估算（内部会剪枝；刚有 delta 必然有数据，但做防御性处理）
		if (this._onEstimate) {
			const estimate = this.currentEstimate();
			if (estimate !== null) {
				this._onEstimate(estimate);
			}
		}
	}

	/**
	 * 当前实时估算 TPS（无数据时返回 null）。
	 * 先按时间窗剪枝，再算 窗口字符 ÷ 窗口时长。
	 */
	currentEstimate(): number | null {
		if (this._firstDeltaMs === null) {
			return null;
		}
		const now = this._now();
		this._pruneWindow(now);
		if (this._windowChunks.length === 0) {
			return null;
		}
		const windowSpan = Math.min(now - this._windowChunks[0].t, TPS_WINDOW_MS);
		if (windowSpan <= 0) {
			return null;
		}
		const chars = this._windowChunks.reduce((s, c) => s + c.chars, 0);
		const ratio = getCalibratedRatio(this.modelId);
		const tokens = chars / ratio;
		return (tokens / windowSpan) * 1000;
	}

	/**
	 * 请求结束（含中断）时调用：返回结算结果。
	 * @param usage 服务端权威 token 用量（可空）
	 */
	finalize(usage: { completion_tokens: number } | null | undefined): RequestTpsResult {
		if (this._stallTimer) {
			clearTimeout(this._stallTimer);
			this._stallTimer = null;
		}

		const result: RequestTpsResult = {
			modelId: this.modelId,
			ok: false,
			reason: "",
		};

		if (this._firstDeltaMs === null) {
			// 全程没有非空输出（要么真没吐字，要么假流式 done 一次性输出）
			result.reason = "no_delta";
			if (this._onDone) {
				this._onDone(result);
			}
			return result;
		}

		const streamSpanMs = (this._lastDeltaMs ?? this._now()) - this._firstDeltaMs;
		if (streamSpanMs <= 0 || !usage || !usage.completion_tokens) {
			// 数据不足或网关未回 usage：只有估算值可用
			result.reason = "no_usage" + (streamSpanMs <= 0 ? "_too_fast" : "");
			if (this._onDone) {
				this._onDone(result);
			}
			return result;
		}

		const tps = (usage.completion_tokens / streamSpanMs) * 1000;
		result.ok = true;
		result.tps = tps;
		result.ttftMs = this._firstDeltaMs - this._streamStartMs;
		result.streamDurationMs = streamSpanMs;
		result.completionTokens = usage.completion_tokens;
		result.chars = this._totalChars;
		result.burstOnly = this._isBurstOnly;
		// 校准值为「字符/token」：chars / completion_tokens，越大说明字符越省 token
		result.calibratedRatio = this._totalChars > 0 ? this._totalChars / usage.completion_tokens : undefined;

		// 用本次实测校准系数（EMA 更新）
		if (this._totalChars > 0 && result.calibratedRatio) {
			updateCalibratedRatio(this.modelId, result.calibratedRatio);
		}

		if (this._onDone) {
			this._onDone(result);
		}
		return result;
	}

	/**
	 * HTTP 层面失败（fetch 未 resolve、非 2xx 等）：结束统计但不产生数据。
	 */
	abort(reason: string): void {
		if (this._stallTimer) {
			clearTimeout(this._stallTimer);
			this._stallTimer = null;
		}
		if (this._onDone) {
			this._onDone({ modelId: this.modelId, ok: false, reason });
		}
	}

	/**
	 * 剪枝：丢弃窗口起点之前的所有 chunk。
	 */
	private _pruneWindow(now: number): void {
		const cutoff = now - TPS_WINDOW_MS;
		while (this._windowChunks.length > 0 && this._windowChunks[0].t < cutoff) {
			this._windowChunks.shift();
		}
	}

	/**
	 * 重置停顿检测定时器。
	 */
	private _resetStallWatch(): void {
		if (this._stallTimer) {
			clearTimeout(this._stallTimer);
		}
		this._stallTimer = setTimeout(() => {
			this._stalled = true;
			if (this._onStall) {
				this._onStall(true);
			}
		}, STALL_THRESHOLD_MS);
	}
}

/** 一次请求的结算统计结果 */
export interface RequestTpsResult {
	modelId: string;
	ok: boolean;
	reason: string;
	/** 生成 TPS（token/s），含思考 token */
	tps?: number;
	/** 首 token 延迟（ms） */
	ttftMs?: number;
	/** 流式时长（ms，首个非空 delta → 末个非空 delta） */
	streamDurationMs?: number;
	/** 服务端 completion_tokens */
	completionTokens?: number;
	/** 累计输出字符数（文本 + 思考） */
	chars?: number;
	/** 是否「假流式」（只有 done 一次性输出） */
	burstOnly?: boolean;
	/** 本次实测校准比率（字符/token） */
	calibratedRatio?: number;
}

/**
 * 全局校准系数表：modelId → 字符/token 实测值（EMA 平滑）。
 */

interface CalibrationEntry {
	/** 字符/token（实测 = chars / completion_tokens，数值越大说明字符越省 token） */
	ratio: number;
	/** 参与过的样本数 */
	samples: number;
}

const calibrationTable = new Map<string, CalibrationEntry>();

/**
 * 取某模型的校准系数（字符/token），无记录时用默认值。
 */
export function getCalibratedRatio(modelId: string): number {
	const entry = calibrationTable.get(modelId);
	if (!entry || entry.samples < MIN_CALIBRATION_SAMPLES || entry.ratio <= 0) {
		return DEFAULT_CHARS_PER_TOKEN;
	}
	return entry.ratio;
}

/**
 * 用一次实测更新校准系数（EMA）。
 * @param modelId 模型 ID
 * @param measuredRatio 实测 字符/token
 */
export function updateCalibratedRatio(modelId: string, measuredRatio: number): void {
	if (!(measuredRatio > 0)) {
		return;
	}
	const existing = calibrationTable.get(modelId);
	if (!existing) {
		calibrationTable.set(modelId, { ratio: measuredRatio, samples: 1 });
		return;
	}
	existing.ratio = existing.ratio * (1 - CALIBRATION_EMA_ALPHA) + measuredRatio * CALIBRATION_EMA_ALPHA;
	existing.samples += 1;
}

/** 测试用：清空校准表 */
export function resetCalibrationTable(): void {
	calibrationTable.clear();
}

/** 测试用：查看校准表 */
export function peekCalibrationTable(): Map<string, CalibrationEntry> {
	return calibrationTable;
}

/**
 * 判断一个 part 是否算「正在产生内容」（文本/思考），工具调用/数据不算。
 * 供 provider.ts 的 trackingProgress 使用——工具调用也是模型产出，
 * 但短期内不计入 TPS（吞吐目标是「吐字」，工具调用会污染字符/秒）。
 */
export function isContentPart(part: LanguageModelResponsePart2): boolean {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const p = part as { value?: unknown; mimeType?: unknown };
	return p.mimeType === undefined && p.value !== undefined;
}

/**
 * 从 part 中提取文本内容（拼接 value，TextPart 为 string、ThinkingPart 为 string | string[]）。
 */
export function extractPartText(part: LanguageModelResponsePart2): string {
	if (typeof part !== "object" || part === null) {
		return "";
	}
	const p = part as { value?: unknown; mimeType?: unknown };
	if (p.mimeType !== undefined) {
		return "";
	}
	if (typeof p.value === "string") {
		return p.value;
	}
	if (Array.isArray(p.value)) {
		return p.value.map((v) => (typeof v === "string" ? v : "")).join("");
	}
	return "";
}

// 日志输出（结束时记录一条）
export function logRequestTps(result: RequestTpsResult): void {
	if (result.ok) {
		logger.info("usage.tps", {
			modelId: result.modelId,
			tps: Number(result.tps?.toFixed(1)),
			ttftMs: result.ttftMs,
			streamDurationMs: result.streamDurationMs,
			completionTokens: result.completionTokens,
			burstOnly: result.burstOnly ?? false,
		});
	} else {
		logger.warn("usage.tps.skipped", {
			modelId: result.modelId,
			reason: result.reason,
		});
	}
}
