import * as path from "path";
import * as vscode from "vscode";
import { logger } from "./logger";
import { WECHAT_NOTIFY_CONFIG_FILE_NAME, WECHAT_NOTIFY_HOOK_DIR } from "./wechatNotifyPaths";

/**
 * 忽略规则写入结果。
 * added=本次写入；present=已有等价规则；unavailable=配置文件不在任何仓库内；failed=写入出错
 */
export type WechatNotifyGitIgnoreStatus = "added" | "present" | "unavailable" | "failed";

const IGNORE_COMMENT = "# 企微联动本地参数（含私密 webhook），不入库";

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** 从工作区根上溯定位 git 仓库根；.git 可能是目录，也可能是 worktree 的文件 */
async function resolveGitRoot(start: vscode.Uri): Promise<vscode.Uri> {
	let current = start;
	for (;;) {
		if (await exists(vscode.Uri.joinPath(current, ".git"))) {
			return current;
		}
		const parent = vscode.Uri.joinPath(current, "..");
		if (parent.fsPath === current.fsPath) {
			// 一路到盘符都没找到仓库：退回工作区根，规则写在那里仍能被将来的提交读到
			return start;
		}
		current = parent;
	}
}

/** 去掉行首的 / 与 ./，只做精确匹配：宁可多写一行重复规则，也不误判成"已忽略"而漏掉 */
function normalizeEntry(line: string): string {
	return line.trim().replace(/^\/+/, "").replace(/^\.\//g, "");
}

/**
 * 把 .github/hooks/WechatNotify.local.psd1 写进 git 忽略列表。
 *
 * psd1 存着明文 webhook，创建后必须入库外：只追加不动已有内容，
 * 已有等价规则时不重复写。写入失败只回报，不打断 hook 创建。
 */
export async function ensureWechatNotifyIgnored(): Promise<WechatNotifyGitIgnoreStatus> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return "unavailable";
	}
	try {
		const root = await resolveGitRoot(folder.uri);
		const target = vscode.Uri.joinPath(
			folder.uri,
			...WECHAT_NOTIFY_HOOK_DIR,
			WECHAT_NOTIFY_CONFIG_FILE_NAME
		);
		const entry = path.relative(root.fsPath, target.fsPath).split(path.sep).join("/");
		if (!entry || entry.startsWith("..")) {
			return "unavailable";
		}

		const gitIgnoreUri = vscode.Uri.joinPath(root, ".gitignore");
		const existing = (await exists(gitIgnoreUri))
			? new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(gitIgnoreUri))
			: "";
		const covered = existing.split(/\r?\n/).some((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
				return false;
			}
			return normalizeEntry(trimmed) === entry;
		});
		if (covered) {
			return "present";
		}

		// 原文件末尾没有换行时先补一个，否则新规则会被粘到最后一行后面
		const body = existing.replace(/\s+$/, "");
		const text = `${body ? `${body}\n\n` : ""}${IGNORE_COMMENT}\n${entry}\n`;
		await vscode.workspace.fs.writeFile(gitIgnoreUri, new TextEncoder().encode(text));
		return "added";
	} catch (error) {
		logger.warn("wechatNotify.gitignore", {
			error: error instanceof Error ? error.message : String(error),
		});
		return "failed";
	}
}
