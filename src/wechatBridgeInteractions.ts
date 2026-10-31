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

/** sidecar 里标记「提问已收场」的行；与 hook 脚本里的同名常量必须一致 */
export const INTERACTION_DONE_KIND = "done";

/** 去重表上限：只防止长期运行无限增长，正常一次会话远到不了 */
const MAX_TRACKED_IDS = 500;

/**
 * 一次「等你回答」的提问。它与 LiveTurn 分开走：提问发生在轮次中间，本轮不会结束。
 */
export interface PendingInteraction {
	sessionId: string;
	/** 提问工具的 toolCallId，用于去重 */
	toolCallId: string;
	/**
	 * 核心里的提问轮播 id。注意**不是** toolCallId：核心把 copilot 内部 id 的
	 * `__vscode-<n>` 后缀剥掉才当作轮播 id（见 toResolveId）。
	 */
	resolveId: string;
	/** 本次提问的结构化内容，作答时要按 index 与 options 组装答案 */
	questions: PendingQuestion[];
	/** 已渲染成 markdown 的提问正文 */
	markdown: string;
}

/** 一个待回答的问题，字段与核心的 IChatQuestion 对齐（只保留作答需要的那部分） */
export interface PendingQuestion {
	/** 0 基下标，与核心的 `${resolveId}:${index}` 一致 */
	index: number;
	header: string;
	text: string;
	/** 选项，顺序即用户看到的编号。作答必须用 `label`，不能用拼了描述的显示文本 */
	options: PendingOption[];
	multiSelect: boolean;
}

export interface PendingOption {
	label: string;
	description: string;
}

/** 把 hook 写下的 sidecar 行解析成事件 */
interface InteractionEvent {
	toolCallId: string;
	sessionId: string;
	resolveId: string;
	questions: PendingQuestion[];
	markdown: string;
}

/**
 * 一次轮询里看到的通知。
 *
 * `done` 来自 PostToolUse hook：提问工具一旦返回（无论谁答的、还是被取消），
 * 那个轮播就再也不能作答了。没有它就只能靠 TTL 猜，用户会在电脑上答完后又
 * 收到一句「已提交」。只按工具名匹配，不需要 toolCallId 配对 —— 提问工具是串行的。
 */
export type InteractionNotice =
	| { kind: "ask"; interaction: PendingInteraction }
	| { kind: "done"; sessionId: string };

type TailEvent =
	| { kind: "ask"; event: InteractionEvent }
	| { kind: "done"; sessionId: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * 剥掉 copilot 内部 tool call id 的 `__vscode-<n>` 后缀。
 *
 * 两侧取值不同源同一个变量：hook 拿到的 tool_use_id 是完整的 `props.toolCall.id`，
 * 而核心给提问轮播用的 resolveId 是 `props.toolCall.id.split('__vscode')[0]`
 * （toolCalling.tsx:301 与 :327）。不剥后缀，作答命令必然匹配不上而静默失效。
 */
export function toResolveId(toolCallId: string): string {
	const at = toolCallId.indexOf("__vscode");
	return at >= 0 ? toolCallId.slice(0, at) : toolCallId;
}

/**
 * 把 vscode_askQuestions 的参数解析成结构化问题。
 * 类型推导与核心一致：没有选项是 text，有选项且 multiSelect 是 multiSelect，其余 singleSelect。
 */
export function parseQuestions(value: unknown): PendingQuestion[] {
	const list = asRecord(value)?.questions;
	if (!Array.isArray(list)) {
		return [];
	}
	const questions: PendingQuestion[] = [];
	for (const raw of list) {
		const record = asRecord(raw);
		if (!record) {
			continue;
		}
		const options = (Array.isArray(record.options) ? record.options : [])
			.map((option) => asRecord(option))
			.filter((option): option is Record<string, unknown> => option !== undefined)
			.map((option) => ({ label: readText(option.label).trim(), description: readText(option.description).trim() }))
			.filter((option) => option.label.length > 0);
		questions.push({
			index: questions.length,
			header: readText(record.header).trim(),
			text: readText(record.question).trim(),
			options,
			multiSelect: options.length > 0 && Boolean(record.multiSelect),
		});
	}
	return questions;
}

/**
 * 剥掉 label 自带的序号，避免渲染成「1. 1. 生产」。
 *
 * 模型生成参数时经常自己给选项编号（实测写成 `1 · 手机端显示…`），我们再补一层就重复了。
 * 只剥「序号等于这一项位置」的前缀，且 `1.5` 这种不算（点号后必须有空白），
 * 免得把本身就以数字开头的标签改坏。
 */
export function stripOwnNumber(label: string, position: number): string {
	const match = /^(\d+)\s*(?:[、·:：)）]|\.(?=\s))\s*(?=\S)/.exec(label);
	if (!match || Number(match[1]) !== position) {
		return label;
	}
	return label.slice(match[0].length).trim();
}

/**
 * 把 vscode_askQuestions 的参数渲染成企微可读的 markdown。
 * 参数结构见 copilot 的 IAskQuestionsParams：{ questions: [{ header, question, options[], multiSelect }] }
 */
export function renderQuestions(value: unknown): string {
	const questions = parseQuestions(value);
	const blocks: string[] = [];
	for (const question of questions) {
		const lines: string[] = [];
		if (question.header) {
			lines.push(`**${question.header}**`);
		}
		if (question.text) {
			lines.push(question.text);
		}
		question.options.forEach((option, index) => {
			const label = stripOwnNumber(option.label, index + 1);
			lines.push(`${index + 1}. ${label}${option.description ? ` — ${option.description}` : ""}`);
		});
		if (lines.length > 0) {
			blocks.push(lines.join("\n"));
		}
	}
	if (blocks.length === 0) {
		return "";
	}
	const multi = questions.length > 1;
	return [
		"❓ **VS Code 在等你选择**",
		blocks.join("\n\n"),
		multi
			? `✍️ 直接回复 ${questions.length} 个编号作答（如 \`${questions.map(() => "1").join(" ")}\`），回「跳过」可略过。`
			: "✍️ 直接回复编号作答，发「答 你的内容」可自定义，回「跳过」可略过；也可以在 VS Code 里点选。",
	].join("\n\n");
}

/** transcript 目录的同级 sidecar 目录。目录可能还不存在，调用方自己创建 */
export function resolveInteractionsDir(transcriptsDir: string): string {
	return path.join(path.dirname(transcriptsDir), INTERACTIONS_DIR_NAME);
}

/** 增量跟随单个 sidecar 文件。只在完整行上推进 offset，不会切碎多字节字符 */
class InteractionTail {
	private offset = 0;
	private readonly events: TailEvent[] = [];

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

	collect(): TailEvent[] {
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
			// 完成事件在 hook 侧就标了 kind，不需要再解析参数
			if (readText(record.kind).trim() === INTERACTION_DONE_KIND) {
				this.events.push({ kind: "done", sessionId: this.sessionId });
				continue;
			}
			const toolCallId = readText(record.toolCallId).trim();
			if (!toolCallId) {
				continue;
			}
			const questions = parseQuestions(record.arguments);
			const markdown = renderQuestions(record.arguments);
			if (!markdown) {
				continue;
			}
			this.events.push({
				kind: "ask",
				event: {
					toolCallId,
					sessionId: this.sessionId,
					resolveId: toResolveId(toolCallId),
					questions,
					markdown,
				},
			});
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

	poll(): InteractionNotice[] {
		this.prime();
		const notices: InteractionNotice[] = [];
		for (const filePath of this.listFiles()) {
			for (const item of this.tailFor(filePath).collect()) {
				if (item.kind === "done") {
					notices.push(item);
					continue;
				}
				// hook 每次工具调用都会跑，同一 toolCallId 理论上只写一次；去重防的是重复行
				const key = `${item.event.sessionId}\u0000${item.event.toolCallId}`;
				if (this.seen.has(key)) {
					continue;
				}
				this.seen.add(key);
				notices.push({ kind: "ask", interaction: item.event });
			}
		}
		if (this.seen.size > MAX_TRACKED_IDS) {
			this.seen.clear();
		}
		return notices;
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
