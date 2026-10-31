/**
 * 记录「哪些 prompt 是从企微注入进来的」，供 Stop hook 做去重。
 *
 * 起因：从企微发起的那一轮，回复既会回到企微，又会被 WechatNotify.ps1 当成
 * 普通轮次再推一次群通知，同一个人被通知两遍。
 *
 * 为什么用临时目录里的哈希台账，而不是给 prompt 加标记：
 * - 注入的 prompt 要逐字符落盘（桥接靠它精确匹配本轮），加标记会污染用户可见文本
 * - hook 是独立进程，只能读文件
 * - 只写哈希不写原文：台账文件在 Temp 下，不该留对话内容
 *
 * ps1 侧读写同一个文件名与同一套哈希算法（SHA-256 over UTF-8，先 trim）。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BRIDGE_PROMPT_LEDGER_FILE = "libiao-copilot-bridge-prompts.jsonl";

/** 超过这个时间的记录不再参与比对：一轮对话不可能拖这么久才结束 */
export const BRIDGE_PROMPT_LEDGER_TTL_MS = 30 * 60_000;

/** 文件行数上限，超出时重写成最近 TAIL_KEEP 条，避免在 Temp 下无限增长 */
const LEDGER_MAX_LINES = 200;
const LEDGER_TAIL_KEEP = 50;

export function bridgePromptLedgerPath(tmpDir = os.tmpdir()): string {
	return path.join(tmpDir, BRIDGE_PROMPT_LEDGER_FILE);
}

/**
 * 台账里用的哈希。
 * 两边都先 trim：注入时已经 trim 过，但 transcript 落盘的 content 可能带前导空白。
 */
export function bridgePromptHash(text: string): string {
	return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

/**
 * 追加一条注入记录。写失败不影响桥接主流程（去重失效只是多推一条通知）。
 */
export function appendBridgePromptRecord(prompt: string, now = Date.now(), tmpDir = os.tmpdir()): void {
	const file = bridgePromptLedgerPath(tmpDir);
	const line = `${JSON.stringify({ h: bridgePromptHash(prompt), at: now })}\n`;
	try {
		fs.appendFileSync(file, line, "utf8");
		trimLedger(file);
	} catch {
		// 临时目录不可写：放弃去重，不抛
	}
}

function trimLedger(file: string): void {
	let lines: string[];
	try {
		lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch {
		return;
	}
	if (lines.length <= LEDGER_MAX_LINES) {
		return;
	}
	const kept = lines.slice(-LEDGER_TAIL_KEEP);
	try {
		fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
	} catch {
		// 同上，忽略
	}
}

/**
 * 判断某个 prompt 是否由桥接注入。
 * 供测试与诊断使用；hook 侧有等价的 pwsh 实现。
 */
export function isBridgeInjectedPrompt(prompt: string, now = Date.now(), tmpDir = os.tmpdir()): boolean {
	const target = bridgePromptHash(prompt);
	let content: string;
	try {
		content = fs.readFileSync(bridgePromptLedgerPath(tmpDir), "utf8");
	} catch {
		return false;
	}
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const record = entry as { h?: unknown; at?: unknown };
		if (typeof record.h !== "string" || record.h !== target) {
			continue;
		}
		const at = typeof record.at === "number" ? record.at : 0;
		if (now - at <= BRIDGE_PROMPT_LEDGER_TTL_MS) {
			return true;
		}
	}
	return false;
}
