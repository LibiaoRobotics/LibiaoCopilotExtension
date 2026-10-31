/**
 * 从 VS Code 的 chatSessions 日志里取出某一轮的最终 Markdown 正文。
 *
 * 为什么必须自己解析：`chat.open` 的 `blockOnResponse` 只返回 IChatAgentResult，
 * 里面的 parts 仅用于上报工具确认态，不含正文（1.134 bundle 取证）。
 *
 * 日志格式（实测 1.144 会话）：每行一个 JSON-patch 记录
 * - kind 0：整体替换，v 就是完整快照
 * - kind 1：按 k 路径赋值 v
 * - kind 2：按 k 路径对数组做 splice，i 表示先截断到长度 i，v 为追加项
 * - kind 3：按 k 路径删除
 * 正文位置：requests[i].response 中「没有 kind 字段且 value 为 string」的部件
 * （thinking / toolInvocation 等部件都带 kind，会被排除）。
 * 轮次完成标志：requests[i].result 出现。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePromptText } from "./wechatBridgeSettings";

interface SessionPatchEntry {
	kind: number;
	k?: (string | number)[];
	v?: unknown;
	i?: number;
}

export interface ChatSessionTurn {
	promptText: string;
	markdown: string;
	completed: boolean;
	matched: "exact" | "fallback";
}

export interface ChatSessionFile {
	filePath: string;
	mtimeMs: number;
}

export function listChatSessionFiles(directory: string, sinceMs: number): ChatSessionFile[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: ChatSessionFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
			continue;
		}
		const filePath = path.join(directory, entry.name);
		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs >= sinceMs) {
				files.push({ filePath, mtimeMs: stat.mtimeMs });
			}
		} catch {
			// 文件正在被替换，忽略即可，下次轮询还会看到
		}
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stepInto(cursor: unknown, key: string | number): unknown {
	if (Array.isArray(cursor)) {
		return cursor[Number(key)];
	}
	const record = asRecord(cursor);
	return record ? record[String(key)] : undefined;
}

function applyPatch(root: unknown, entry: SessionPatchEntry): unknown {
	if (entry.kind === 0) {
		return entry.v ?? null;
	}
	const keys = entry.k;
	if (!Array.isArray(keys) || keys.length === 0) {
		return root;
	}
	let cursor: unknown = root;
	for (let index = 0; index < keys.length - 1; index++) {
		cursor = stepInto(cursor, keys[index]);
		if (cursor === undefined || cursor === null) {
			return root;
		}
	}
	const lastKey = keys[keys.length - 1];
	if (entry.kind === 3) {
		const record = asRecord(cursor);
		if (record) {
			delete record[String(lastKey)];
		}
		return root;
	}
	if (entry.kind === 1) {
		if (Array.isArray(cursor)) {
			cursor[Number(lastKey)] = entry.v;
		} else {
			const record = asRecord(cursor);
			if (record) {
				record[String(lastKey)] = entry.v;
			}
		}
		return root;
	}
	if (entry.kind === 2) {
		const record = asRecord(cursor);
		if (!record) {
			return root;
		}
		const key = String(lastKey);
		const existing = record[key];
		let next: unknown[] = Array.isArray(existing) ? existing.slice() : [];
		if (typeof entry.i === "number" && entry.i >= 0) {
			next = next.slice(0, entry.i);
		}
		if (Array.isArray(entry.v)) {
			next = next.concat(entry.v);
		} else if (entry.v !== undefined) {
			next = next.concat([entry.v]);
		}
		record[key] = next;
		return root;
	}
	return root;
}

/** 纯函数版重放：给测试与一次性解析用 */
export function replaySessionLog(lines: readonly string[]): unknown {
	let session: unknown = null;
	for (const line of lines) {
		const trimmed = line.replace(/^\uFEFF/, "").trim();
		if (!trimmed) {
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const patch = asRecord(entry);
		if (!patch || typeof patch.kind !== "number") {
			continue;
		}
		session = applyPatch(session, patch as unknown as SessionPatchEntry);
	}
	return session;
}

/** 只拼接无 kind 的 string 部件，得到本轮最终正文 */
export function extractAssistantMarkdown(response: unknown): string {
	if (!Array.isArray(response)) {
		return "";
	}
	let markdown = "";
	for (const part of response) {
		const record = asRecord(part);
		if (!record || record.kind !== undefined) {
			continue;
		}
		if (typeof record.value === "string") {
			markdown += record.value;
		}
	}
	return markdown;
}

function readRequestText(request: unknown): string {
	const record = asRecord(request);
	if (!record) {
		return "";
	}
	const message = asRecord(record.message);
	if (!message) {
		return "";
	}
	if (typeof message.text === "string") {
		return message.text;
	}
	const parts = message.parts;
	if (!Array.isArray(parts)) {
		return "";
	}
	let text = "";
	for (const part of parts) {
		const partRecord = asRecord(part);
		if (partRecord && partRecord.type === "text" && typeof partRecord.text === "string") {
			text += partRecord.text;
		}
	}
	return text;
}

function readRequestTimestamp(request: unknown): number | undefined {
	const record = asRecord(request);
	if (!record) {
		return undefined;
	}
	const timestamp = record.timestamp;
	if (typeof timestamp === "number") {
		return timestamp;
	}
	if (typeof timestamp === "string") {
		const parsed = Date.parse(timestamp);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function toTurn(request: unknown, matched: ChatSessionTurn["matched"]): ChatSessionTurn {
	const record = asRecord(request);
	return {
		promptText: readRequestText(request),
		markdown: record ? extractAssistantMarkdown(record.response) : "",
		completed: Boolean(record && asRecord(record.result)),
		matched,
	};
}

/**
 * 找到与注入 prompt 匹配的那一轮。从后往前找，取最近的一次。
 * sinceMs 用于排除注入之前的旧轮次（自己发的、时间相近的重复提问都可能重名）。
 */
export function findTurnByPrompt(
	session: unknown,
	prompt: string,
	sinceMs: number
): ChatSessionTurn | undefined {
	const requests = asRecord(session)?.requests;
	if (!Array.isArray(requests)) {
		return undefined;
	}
	const expected = normalizePromptText(prompt);
	for (let index = requests.length - 1; index >= 0; index--) {
		const request = requests[index];
		const timestamp = readRequestTimestamp(request);
		if (timestamp !== undefined && timestamp < sinceMs) {
			continue;
		}
		if (normalizePromptText(readRequestText(request)) === expected) {
			return toTurn(request, "exact");
		}
	}
	return undefined;
}

/** 文本对不上时的兜底：取注入之后最近的一轮 */
export function findLatestTurn(session: unknown, sinceMs: number): ChatSessionTurn | undefined {
	const requests = asRecord(session)?.requests;
	if (!Array.isArray(requests)) {
		return undefined;
	}
	for (let index = requests.length - 1; index >= 0; index--) {
		const request = requests[index];
		const timestamp = readRequestTimestamp(request);
		if (timestamp !== undefined && timestamp < sinceMs) {
			continue;
		}
		return toTurn(request, "fallback");
	}
	return undefined;
}

/**
 * 增量跟随一个会话日志文件。
 * 只在完整行（或可解析的尾部）上推进 offset，因此不会切碎 UTF-8 多字节字符。
 */
export class ChatSessionLogTail {
	private session: unknown = null;
	private offset = 0;

	constructor(private readonly filePath: string) {}

	refresh(): void {
		let size: number;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return;
		}
		if (size < this.offset) {
			// 文件被截断或替换，重新来
			this.session = null;
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
		if (lastNewline >= 0) {
			this.consume(chunk.subarray(0, lastNewline + 1).toString("utf8"));
			this.offset += lastNewline + 1;
		}
		const tailOffset = lastNewline + 1;
		if (tailOffset < read) {
			const tail = chunk.subarray(tailOffset).toString("utf8");
			if (this.consume(tail)) {
				this.offset += read - tailOffset;
			}
		}
	}

	/** 返回是否消费成功（尾部半行未写完时返回 false，留给下次重试） */
	private consume(text: string): boolean {
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const isLast = index === lines.length - 1;
			const trimmed = line.replace(/^\uFEFF/, "").trim();
			if (!trimmed) {
				continue;
			}
			let entry: unknown;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				if (isLast) {
					return false;
				}
				continue;
			}
			const patch = asRecord(entry);
			if (!patch || typeof patch.kind !== "number") {
				continue;
			}
			this.session = applyPatch(this.session, patch as unknown as SessionPatchEntry);
		}
		return true;
	}

	get snapshot(): unknown {
		return this.session;
	}
}

export interface ChatSessionTurnMatch {
	filePath: string;
	turn: ChatSessionTurn;
}

/**
 * 在 chatSessions 目录下找本轮回复。
 * 先用 prompt 精确匹配所有候选会话；都对不上再退化为「最近写入的最新一轮」。
 */
export class ChatSessionScanner {
	private readonly tails = new Map<string, ChatSessionLogTail>();

	constructor(private readonly directory: string) {}

	findTurn(prompt: string, sinceMs: number): ChatSessionTurnMatch | undefined {
		const files = listChatSessionFiles(this.directory, sinceMs);
		if (files.length === 0) {
			return undefined;
		}
		const live = new Set(files.map((file) => file.filePath));
		for (const filePath of this.tails.keys()) {
			if (!live.has(filePath)) {
				this.tails.delete(filePath);
			}
		}
		let best: ChatSessionTurnMatch | undefined;
		for (const file of files) {
			let tail = this.tails.get(file.filePath);
			if (!tail) {
				tail = new ChatSessionLogTail(file.filePath);
				this.tails.set(file.filePath, tail);
			}
			tail.refresh();
			const turn = findTurnByPrompt(tail.snapshot, prompt, sinceMs);
			if (turn) {
				return { filePath: file.filePath, turn };
			}
			if (!best) {
				const fallback = findLatestTurn(tail.snapshot, sinceMs);
				if (fallback) {
					best = { filePath: file.filePath, turn: fallback };
				}
			}
		}
		return best;
	}
}
