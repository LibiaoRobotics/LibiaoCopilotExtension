/**
 * 实时读取 VS Code 的 agent transcript（`<workspaceStorage>/<hash>/*／transcripts/<sessionId>.jsonl`），
 * 拿到每一轮的正文。
 *
 * 为什么不用 chatSessions：那份日志是**批量刷盘**的。实测 2034 次 `result` 落盘时刻全部落在
 * 每分钟两个 3~4 秒的窗口里（:29~:32 与 :47~:50），其余秒一次都没有，因此「请求结束」到
 * 「日志里能看到」之间是 0~40 秒的随机滞后。transcript 则是逐条追加，延迟在 1 秒量级。
 *
 * transcript 的事件序列（实测 1.144 / copilot-chat 0.72）：
 *   session.start
 *   user.message            data.content 即本轮 prompt
 *   assistant.turn_start    data.turnId；一次请求会拆成多个 turn（每个工具步骤一个）
 *   assistant.message       data.content 是正文；只发工具调用时为空串
 *   tool.execution_start / tool.execution_complete
 *   assistant.turn_end      标记单个 turn 结束，**不代表整个请求结束**
 *
 * 因此「整个请求结束」的判据是：最后一条事件是 turn_end，且此后静默 TURN_IDLE_MS。
 * 实测 turn_end 后若还有下一步，下一个事件在 0~1 毫秒内就到了（181/184 次为 0ms，
 * 3 次为 1ms），而真实轮次边界是 63 毫秒起步（多数几秒到几十秒），500 毫秒阈值足够安全。
 *
 * 思考过程天然被排除：transcript 里没有 thinking 事件，正文只在 assistant.message.content。
 *
 * 子代理（runSubagent）的事件同样写进这个文件，并挂在同一条 parentId 链上，没有任何
 * 「我是子代理」的标记。实测一次 Explore 任务会把两段以下的中间说明和整份调研报告混进主轮
 * 正文（还会因为子代理自己的 user.message 提前把主轮 flush 掉，顺序全乱）。
 * 唯一可靠的判据是 runSubagent 的 toolCallId：execution_start 与 execution_complete 之间
 * 的事件全都不属于本轮。
 *
 * vscode_askQuestions 是阻塞工具：用户回答前它不返回、也不写 turn_end。但它**不能**靠这个
 * 文件来提醒——`tool.execution_start` 只是先进内存缓冲，真正落盘要等 flush()，而 flush() 只在
 * hook 执行前与上下文压缩前发生。实测 90 秒等待期间文件字节零增长，答完才把 start/complete
 * 一起写下来，按顺序处理时必然被 complete 又抵消掉。这类提醒改走 preToolUse hook 落盘的
 * sidecar，见 wechatBridgeInteractions.ts。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePromptText } from "./wechatBridgeSettings";

/** turn_end 之后静默这么久，就认定整个请求已结束 */
export const LIVE_TURN_IDLE_MS = 500;

/** 单个 transcript 文件超过这个长度就不再回放历史（只从尾部跟） */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

/** 子代理工具：它的执行区间与本轮共用 transcript，但正文不属于本轮 */
const SUBAGENT_TOOL_NAME = "runSubagent";

/**
 * 子代理异常中断（窗口关闭、用户停止）时不会写 execution_complete。
 * 不给上限的话这个标记会一直挂着，之后所有真实轮次都会被当成子代理正文丢掉。
 */
const STALE_SUBAGENT_MS = 30 * 60_000;

export interface LiveTurn {
	/** 会话 id，等于 transcript 文件名 */
	sessionId: string;
	turnId: string;
	prompt: string;
	/** 本轮所有非空 assistant.message.content，按出现顺序拼接 */
	markdown: string;
	/** 判定结束的时刻（本地时钟毫秒） */
	endedAt: number;
}

interface TranscriptEvent {
	type: string;
	data?: Record<string, unknown>;
	timestamp?: string;
}

interface PendingRequest {
	prompt: string;
	turnId: string;
	texts: string[];
	lastEventAt: number;
	lastType: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readTimestamp(event: TranscriptEvent): number | undefined {
	if (typeof event.timestamp !== "string") {
		return undefined;
	}
	const parsed = Date.parse(event.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function readText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** turnId 在真实 transcript 里是数字（1、2、3…），别只认字符串 */
function readId(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return typeof value === "number" ? String(value) : "";
}

/**
 * 从 workspaceStorage 的 `<hash>/chatSessions` 反推出 transcript 目录。
 * VS Code 把 transcript 放在 `<hash>/<扩展 id>/transcripts`，扩展 id 因版本而异，
 * 所以先试已知的 GitHub.copilot-chat，再扫同级任意子目录。
 */
export function resolveTranscriptsDir(chatSessionsDir: string): string | undefined {
	const base = path.dirname(chatSessionsDir);
	const known = path.join(base, "GitHub.copilot-chat", "transcripts");
	if (fs.existsSync(known)) {
		return known;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const candidate = path.join(base, entry.name, "transcripts");
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * 增量跟随一个 transcript 文件。
 * 只在完整行上推进 offset，因此不会切碎 UTF-8 多字节字符。
 */
class TranscriptTail {
	private offset = 0;
	private pending: PendingRequest | undefined;
	private readonly completed: LiveTurn[] = [];
	/** 正在执行的子代理：toolCallId → 开始时刻（本地时钟） */
	private readonly subagentRuns = new Map<string, number>();

	constructor(
		private readonly sessionId: string,
		private readonly filePath: string
	) {}

	/** 首次打开时丢掉已有历史：老轮次不该被当成新轮次推出去 */
	prime(): void {
		let size = 0;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return;
		}
		this.offset = Math.max(0, size - MAX_REPLAY_BYTES);
		this.consume(Date.now(), false);
		// 基线不含任何半成品轮次：最后一条事件刚落下、还没静默够的那种也不能留到下次 poll
		this.pending = undefined;
		this.completed.length = 0;
		this.subagentRuns.clear();
	}

	/** 读增量并返回新完成的轮次（消费即清空） */
	collect(now: number): LiveTurn[] {
		this.consume(now, true);
		if (this.completed.length === 0) {
			return [];
		}
		return this.completed.splice(0, this.completed.length);
	}

	/** 只读观察：该 prompt 是否已经在写入中（不消费轮次，也不动 offset） */
	hasPendingPrompt(key: string): boolean {
		return this.pending ? normalizePromptText(this.pending.prompt) === key : false;
	}

	/** 只读观察：当前是否有请求正在跑（含尚未结束的上一轮）。用于区分「注入排队」与「注入失败」 */
	isBusy(): boolean {
		return this.pending !== undefined;
	}

	private consume(now: number, emit: boolean): void {
		this.readNewLines(now, emit);
		this.flushIfIdle(now, emit);
	}

	private readNewLines(now: number, emit: boolean): void {
		let size: number;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return;
		}
		if (size < this.offset) {
			// 文件被截断或替换，重新跟
			this.offset = 0;
			this.pending = undefined;
		}
		if (size === this.offset) {
			return;
		}
		const length = size - this.offset;
		const buffer = Buffer.allocUnsafe(length);
		let fd: number | undefined;
		let read = 0;
		try {
			fd = fs.openSync(this.filePath, "r");
			read = fs.readSync(fd, buffer, 0, length, this.offset);
		} catch {
			return;
		} finally {
			if (fd !== undefined) {
				fs.closeSync(fd);
			}
		}
		if (read <= 0) {
			return;
		}
		const chunk = buffer.subarray(0, read);
		const lastNewline = chunk.lastIndexOf(0x0a);
		if (lastNewline < 0) {
			return;
		}
		const text = chunk.subarray(0, lastNewline + 1).toString("utf8");
		this.offset += lastNewline + 1;
		for (const line of text.split("\n")) {
			const trimmed = line.replace(/^\uFEFF/, "").trim();
			if (!trimmed) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			this.apply(asRecord(parsed) as TranscriptEvent | undefined, now, emit);
		}
	}

	/** 子代理运行期间，主轮既不收集正文也不判结束；顺带回收异常中断留下的标记 */
	private isSubagentActive(now: number): boolean {
		for (const [toolCallId, startedAt] of this.subagentRuns) {
			if (now - startedAt > STALE_SUBAGENT_MS) {
				this.subagentRuns.delete(toolCallId);
			}
		}
		return this.subagentRuns.size > 0;
	}

	private apply(event: TranscriptEvent | undefined, now: number, emit: boolean): void {
		if (!event || typeof event.type !== "string") {
			return;
		}
		const data = asRecord(event.data) ?? {};
		const at = readTimestamp(event) ?? now;
		switch (event.type) {
			case "user.message": {
				// 子代理有自己的 prompt：它不是用户发来的新一轮，更不能拿它把主轮收掉
				if (this.isSubagentActive(now)) {
					return;
				}
				// 上一条请求还没判定结束就来了新 prompt：说明它其实已经收尾了，按当前状态收掉
				this.flush(now, emit);
				this.pending = {
					prompt: readText(data.content),
					turnId: "",
					texts: [],
					lastEventAt: at,
					lastType: event.type,
				};
				return;
			}
			case "assistant.turn_start": {
				if (this.isSubagentActive(now)) {
					return;
				}
				const current = this.pending;
				if (!current) {
					return;
				}
				current.turnId = readId(data.turnId);
				current.lastEventAt = at;
				current.lastType = event.type;
				return;
			}
			case "assistant.message": {
				if (this.isSubagentActive(now)) {
					return;
				}
				const current = this.pending;
				if (!current) {
					return;
				}
				const content = readText(data.content).trim();
				if (content) {
					current.texts.push(content);
				}
				current.lastEventAt = at;
				current.lastType = event.type;
				return;
			}
			case "assistant.turn_end": {
				if (this.isSubagentActive(now)) {
					return;
				}
				const current = this.pending;
				if (!current) {
					return;
				}
				current.lastEventAt = at;
				current.lastType = event.type;
				return;
			}
			case "tool.execution_start": {
				const toolCallId = readText(data.toolCallId);
				const toolName = readText(data.toolName);
				if (toolName === SUBAGENT_TOOL_NAME) {
					this.subagentRuns.set(toolCallId || `anonymous-${now}`, now);
				}
				return;
			}
			case "tool.execution_complete": {
				const toolCallId = readText(data.toolCallId);
				if (!toolCallId) {
					return;
				}
				this.subagentRuns.delete(toolCallId);
				return;
			}
			default:
				return;
		}
	}

	private flushIfIdle(now: number, emit: boolean): void {
		const current = this.pending;
		if (!current || current.lastType !== "assistant.turn_end") {
			return;
		}
		if (now - current.lastEventAt < LIVE_TURN_IDLE_MS) {
			return;
		}
		this.flush(now, emit);
	}

	private flush(now: number, emit: boolean): void {
		const current = this.pending;
		if (!current) {
			return;
		}
		this.pending = undefined;
		if (!emit) {
			return;
		}
		this.completed.push({
			sessionId: this.sessionId,
			turnId: current.turnId,
			prompt: current.prompt,
			markdown: current.texts.join("\n\n"),
			endedAt: now,
		});
	}

}

/**
 * 扫描 transcripts 目录，产出新完成的轮次。
 *
 * 只提供 `poll()` 一个出口：调用方一次拿全部新轮次，再自己决定分发
 * （企微注入的那轮走 respond_msg，其余推到企微）。
 * 刻意不提供「按 prompt 查找」的读取接口——两条消费路径会互相抢轮次。
 */
export class LiveTurnScanner {
	private readonly tails = new Map<string, TranscriptTail>();
	private primed = false;

	constructor(private readonly directory: string) {}

	/** 建立基线：已有内容不当作新轮次。只生效一次 */
	prime(): void {
		if (this.primed) {
			return;
		}
		this.primed = true;
		for (const filePath of this.listFiles()) {
			this.tailFor(filePath).prime();
		}
	}

	/**
	 * 取走所有新完成的轮次。
	 * `now` 可显式传入：轮次是否结束取决于「最后一条事件之后静默了多久」，回放时需要用固定时钟。
	 */
	poll(now = Date.now()): LiveTurn[] {
		this.prime();
		const turns: LiveTurn[] = [];
		for (const filePath of this.listFiles()) {
			turns.push(...this.tailFor(filePath).collect(now));
		}
		return turns;
	}

	/** 只读观察：某个 prompt 的轮次已经出现但还没结束 */
	hasPendingPrompt(key: string): boolean {
		for (const filePath of this.listFiles()) {
			const tail = this.tails.get(filePath);
			if (tail?.hasPendingPrompt(key)) {
				return true;
			}
		}
		return false;
	}

	/** 只读观察：是否还有请求未结束（含尚未结束的上一轮） */
	isBusy(): boolean {
		for (const filePath of this.listFiles()) {
			if (this.tails.get(filePath)?.isBusy()) {
				return true;
			}
		}
		return false;
	}

	private listFiles(): string[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.directory, { withFileTypes: true });
		} catch {
			return [];
		}
		const files: string[] = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path.join(this.directory, entry.name));
			}
		}
		return files;
	}

	private tailFor(filePath: string): TranscriptTail {
		const existing = this.tails.get(filePath);
		if (existing) {
			return existing;
		}
		// 新出现的文件从 0 开始跟：恢复已有会话用的是同名文件（已被 prime 跳过），
		// 这里能新建出来的只有真正的新会话，内容读全才不漏第一轮
		const tail = new TranscriptTail(path.basename(filePath, ".jsonl"), filePath);
		this.tails.set(filePath, tail);
		return tail;
	}
}
