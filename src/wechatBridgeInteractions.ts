/**
 * 读取 preToolUse hook 落盘的「等待用户选择」事件，产出企微提醒。
 *
 * 为什么必须绕这一圈：
 *   vscode_askQuestions 在用户回答前不返回、不写 turn_end，所以 transcript 里本轮永远判不了
 *   结束；而它的 `tool.execution_start` 虽然一调用就进内存缓冲，真正落盘却要等 flush()，
 *   flush() 全仓库只在 hook 执行前与上下文压缩前发生。实测等待 90 秒期间 transcript 文件
 *   字节零增长，答完才把 start/complete 一起写下来，按顺序消费时必然被 complete 抵消。
 *   所以「有人卡在等你」这件事在磁盘的 transcript 里根本观测不到。
 *
 *   唯一早于阻塞的可靠信号是 preToolUse hook：它在核心生成 confirmationMessages、
 *   进入 awaitConfirmation 之前触发，能拿到 tool_name 与解析后的 tool_input。
 *
 * 通道：hook 是独立进程，不能直接调扩展，因此把事件追加到 sidecar 文件
 *   `<workspaceStorage>/<hash>/<扩展 id>/wechatPending/<sessionId>.jsonl`
 * hook 侧按 transcript_path 反推同一目录（见 assets/hooks/WechatInteract.js），
 * 目录名改动必须两边同步。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** sidecar 目录名；与 assets/hooks/WechatInteract.js 里的同名常量必须一致 */
export const INTERACTIONS_DIR_NAME = "wechatPending";

/** hook 侧只会为这个工具写事件：它是唯一确定会阻塞等用户回答的工具 */
export const ASK_QUESTIONS_TOOL_NAME = "vscode_askQuestions";

/** 去重表上限：只防止长期运行无限增长，正常一次会话远到不了 */
const MAX_TRACKED_IDS = 500;

/**
 * 一次「等你回答」的提问。它与 LiveTurn 分开走：提问发生在轮次中间，本轮不会结束。
 */
export interface PendingInteraction {
	sessionId: string;
	/** 提问工具的 toolCallId，用于去重 */
	toolCallId: string;
	/** 已渲染成 markdown 的提问正文 */
	markdown: string;
}

/** 把 hook 写下的 sidecar 行解析成事件 */
interface InteractionEvent {
	toolCallId: string;
	sessionId: string;
	markdown: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * 把 vscode_askQuestions 的参数渲染成企微可读的 markdown。
 * 参数结构见 copilot 的 IAskQuestionsParams：{ questions: [{ header, question, options[], multiSelect }] }
 */
export function renderQuestions(value: unknown): string {
	const list = asRecord(value)?.questions;
	if (!Array.isArray(list)) {
		return "";
	}
	const blocks: string[] = [];
	for (const raw of list) {
		const question = asRecord(raw);
		if (!question) {
			continue;
		}
		const lines: string[] = [];
		const header = readText(question.header).trim();
		const text = readText(question.question).trim();
		if (header) {
			lines.push(`**${header}**`);
		}
		if (text) {
			lines.push(text);
		}
		const options = Array.isArray(question.options) ? question.options : [];
		options.forEach((option, index) => {
			const record = asRecord(option);
			if (!record) {
				return;
			}
			const label = readText(record.label).trim();
			if (!label) {
				return;
			}
			const description = readText(record.description).trim();
			lines.push(`${index + 1}. ${label}${description ? ` — ${description}` : ""}`);
		});
		if (lines.length > 0) {
			blocks.push(lines.join("\n"));
		}
	}
	if (blocks.length === 0) {
		return "";
	}
	return [
		"❓ **VS Code 在等你选择**",
		blocks.join("\n\n"),
		"请回到 VS Code 里点选，选完我会继续。",
	].join("\n\n");
}

/** transcript 目录的同级 sidecar 目录。目录可能还不存在，调用方自己创建 */
export function resolveInteractionsDir(transcriptsDir: string): string {
	return path.join(path.dirname(transcriptsDir), INTERACTIONS_DIR_NAME);
}

/** 增量跟随单个 sidecar 文件。只在完整行上推进 offset，不会切碎多字节字符 */
class InteractionTail {
	private offset = 0;
	private readonly events: InteractionEvent[] = [];

	constructor(
		private readonly sessionId: string,
		private readonly filePath: string
	) {}

	/** 首次打开时丢掉已有内容：重启后不该把旧提醒再推一遍 */
	prime(): void {
		let size = 0;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return;
		}
		// 直接跳到文件尾：已有内容全部属于基线，不回放
		this.offset = size;
		this.events.length = 0;
	}

	collect(): InteractionEvent[] {
		this.readNewLines();
		if (this.events.length === 0) {
			return [];
		}
		return this.events.splice(0, this.events.length);
	}

	private readNewLines(): void {
		let size: number;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return;
		}
		if (size < this.offset) {
			// 文件被截断或替换，重新跟
			this.offset = 0;
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
			const record = asRecord(parsed);
			if (!record) {
				continue;
			}
			const toolCallId = readText(record.toolCallId).trim();
			if (!toolCallId) {
				continue;
			}
			const markdown = renderQuestions(record.arguments);
			if (!markdown) {
				continue;
			}
			this.events.push({ toolCallId, sessionId: this.sessionId, markdown });
		}
	}
}

/**
 * 扫描 sidecar 目录，产出新的「等你选择」提醒。
 *
 * hook 每个工具调用都会跑一次，但只有 vscode_askQuestions 会写事件，其余不留痕。
 * 消费即清空，调用方自己决定推给谁。
 */
export class InteractionInbox {
	private readonly tails = new Map<string, InteractionTail>();
	private readonly seen = new Set<string>();
	private primed = false;

	constructor(private readonly directory: string) {}

	/** 建立基线：已有内容不当作新提醒。只生效一次 */
	prime(): void {
		if (this.primed) {
			return;
		}
		this.primed = true;
		for (const filePath of this.listFiles()) {
			this.tailFor(filePath).prime();
		}
	}

	poll(): PendingInteraction[] {
		this.prime();
		const pending: PendingInteraction[] = [];
		for (const filePath of this.listFiles()) {
			for (const event of this.tailFor(filePath).collect()) {
				// hook 每次工具调用都会跑，同一 toolCallId 理论上只写一次；去重防的是重复行
				const key = `${event.sessionId}\u0000${event.toolCallId}`;
				if (this.seen.has(key)) {
					continue;
				}
				this.seen.add(key);
				pending.push(event);
			}
		}
		if (this.seen.size > MAX_TRACKED_IDS) {
			this.seen.clear();
		}
		return pending;
	}

	private tailFor(filePath: string): InteractionTail {
		const existing = this.tails.get(filePath);
		if (existing) {
			return existing;
		}
		const sessionId = path.basename(filePath, ".jsonl");
		const tail = new InteractionTail(sessionId, filePath);
		this.tails.set(filePath, tail);
		return tail;
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
}
