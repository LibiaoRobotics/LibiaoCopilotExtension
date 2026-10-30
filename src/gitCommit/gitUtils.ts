import { exec, execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LINE_LIMIT = 500;
/** 提交信息生成用的 diff 行数上限（比通用截断宽一些，避免大改动被削成残片）。 */
const GIT_DIFF_LINE_LIMIT = 3000;
/** 单条 git 命令的最大输出缓冲，避免大仓库 diff 触发默认 1MB 溢出。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** 未跟踪文件逐个合成补丁时的文件数上限，防止未忽略的巨量新文件拖死生成。 */
const MAX_UNTRACKED_FILES = 50;
/** 单个未跟踪文件合成补丁的字符上限。 */
const MAX_SINGLE_FILE_DIFF_CHARS = 20000;

interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	failed: boolean;
}

/**
 * 以参数数组方式执行 git（不经过 shell），避免路径里的空格、括号、中文被当成 shell 语法。
 * 永不抛错；调用方根据 failed / stderr 决定是否上报。
 */
async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", ["--no-pager", ...args], {
			cwd,
			maxBuffer: GIT_MAX_BUFFER,
		});
		return { stdout, stderr, code: 0, failed: false };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
		// 部分失败（如 maxBuffer 溢出）时 stderr 为空，真正的信息在 message 里。
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr || err.message || "",
			code: typeof err.code === "number" ? err.code : 1,
			failed: true,
		};
	}
}

export interface GitCommit {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	date: string;
}

async function checkGitRepo(cwd: string): Promise<boolean> {
	try {
		await execAsync("git rev-parse --git-dir", { cwd });
		return true;
	} catch {
		return false;
	}
}

async function checkGitInstalled(): Promise<boolean> {
	try {
		await execAsync("git --version");
		return true;
	} catch {
		return false;
	}
}

async function checkGitRepoHasCommits(cwd: string): Promise<boolean> {
	try {
		await execAsync("git rev-parse HEAD", { cwd });
		return true;
	} catch {
		return false;
	}
}

export async function searchCommits(query: string, cwd: string): Promise<GitCommit[]> {
	try {
		const isInstalled = await checkGitInstalled();
		if (!isInstalled) {
			console.error("Git is not installed");
			return [];
		}

		const isRepo = await checkGitRepo(cwd);
		if (!isRepo) {
			console.error("Not a git repository");
			return [];
		}

		// Check if repo has any commits
		if (!(await checkGitRepoHasCommits(cwd))) {
			// No commits yet in the repository
			return [];
		}

		// Search commits by hash or message, limiting to 10 results
		const { stdout } = await execAsync(
			`git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short ` + `--grep="${query}" --regexp-ignore-case`,
			{ cwd }
		);

		let output = stdout;
		if (!output.trim() && /^[a-f0-9]+$/i.test(query)) {
			// If no results from grep search and query looks like a hash, try searching by hash
			const { stdout: hashStdout } = await execAsync(
				`git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short ` + `--author-date-order ${query}`,
				{ cwd }
			).catch(() => ({ stdout: "" }));

			if (!hashStdout.trim()) {
				return [];
			}

			output = hashStdout;
		}

		const commits: GitCommit[] = [];
		const lines = output
			.trim()
			.split("\n")
			.filter((line) => line !== "--");

		for (let i = 0; i < lines.length; i += 5) {
			commits.push({
				hash: lines[i],
				shortHash: lines[i + 1],
				subject: lines[i + 2],
				author: lines[i + 3],
				date: lines[i + 4],
			});
		}

		return commits;
	} catch (error) {
		console.error("Error searching commits:", error);
		return [];
	}
}

export async function getCommitInfo(hash: string, cwd: string): Promise<string> {
	try {
		const isInstalled = await checkGitInstalled();
		if (!isInstalled) {
			return "Git is not installed";
		}

		const isRepo = await checkGitRepo(cwd);
		if (!isRepo) {
			return "Not a git repository";
		}

		// Check if repo has any commits
		if (!(await checkGitRepoHasCommits(cwd))) {
			return "Repository has no commits yet";
		}

		// Get commit info, stats, and diff separately
		const { stdout: info } = await execAsync(`git show --format="%H%n%h%n%s%n%an%n%ad%n%b" --no-patch ${hash}`, {
			cwd,
		});
		const [fullHash, shortHash, subject, author, date, body] = info.trim().split("\n");

		const { stdout: stats } = await execAsync(`git show --stat --format="" ${hash}`, { cwd });

		const { stdout: diff } = await execAsync(`git show --format="" ${hash}`, { cwd });

		const summary = [
			`Commit: ${shortHash} (${fullHash})`,
			`Author: ${author}`,
			`Date: ${date}`,
			`\nMessage: ${subject}`,
			body ? `\nDescription:\n${body}` : "",
			"\nFiles Changed:",
			stats.trim(),
			"\nFull Changes:",
		].join("\n");

		const output = summary + "\n\n" + diff.trim();
		return truncateOutput(output);
	} catch (error) {
		console.error("Error getting commit info:", error);
		return `Failed to get commit info: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export async function getWorkingState(cwd: string): Promise<string> {
	try {
		const isInstalled = await checkGitInstalled();
		if (!isInstalled) {
			return "Git is not installed";
		}

		const isRepo = await checkGitRepo(cwd);
		if (!isRepo) {
			return "Not a git repository";
		}

		// Get status of working directory
		const { stdout: status } = await execAsync("git status --short", { cwd });
		if (!status.trim()) {
			return "No changes in working directory";
		}

		// Check if repo has any commits before trying to diff against HEAD
		let diff = "";
		if (await checkGitRepoHasCommits(cwd)) {
			// Only run git diff if there are commits
			const { stdout: diffOutput } = await execAsync("git diff HEAD", { cwd });
			diff = diffOutput;
		} else {
			// No commits yet, use status output only
			return `Working directory changes (new repository):\n\n${status}`;
		}
		const output = `Working directory changes:\n\n${status}\n\n${diff}`.trim();
		return truncateOutput(output);
	} catch (error) {
		console.error("Error getting working state:", error);
		return `Failed to get working state: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * 收集工作区待提交改动并拼成完整 diff 文本。
 *
 * 与旧版本的差别（旧版会让「确实有改动」误报成「没有改动」）：
 * - 不再用 `--diff-filter=d` 过滤删除文件；
 * - 不再用 `git diff HEAD`（仓库无任何提交时 HEAD 不存在，命令直接 128 失败）；
 * - 未跟踪文件用 `git diff --no-index` 合成标准补丁（旧版完全看不到它们）；
 * - 不再「有暂存改动就丢掉未暂存改动」，三类改动合并上报；
 * - 失败时抛出真实的 git 报错，而不是被上层当成「没有改动」。
 *
 * @returns 空字符串表示确实没有待提交改动。
 */
export async function getGitDiff(cwd: string, stagedOnly = false): Promise<string> {
	if (!(await checkGitInstalled())) {
		throw new Error("未检测到 Git，请先安装 Git 并确保 git 命令在 PATH 中。");
	}

	if (!(await checkGitRepo(cwd))) {
		throw new Error(`当前目录不是 Git 仓库：${cwd}`);
	}

	const sections: string[] = [];

	// 1. 已暂存改动（index vs HEAD；无 HEAD 时 git 会自动与空树比较，仍然可用）
	const staged = await runGit(cwd, ["diff", "--staged"]);
	if (staged.failed) {
		throw new Error(`读取已暂存改动失败：${staged.stderr.trim()}`);
	}
	if (staged.stdout.trim()) {
		sections.push(`已暂存改动：\n\n${staged.stdout.trim()}`);
	}

	if (!stagedOnly) {
		// 2. 未暂存改动（工作区 vs index，同样不依赖 HEAD 是否存在）
		const unstaged = await runGit(cwd, ["diff"]);
		if (unstaged.failed) {
			throw new Error(`读取未暂存改动失败：${unstaged.stderr.trim()}`);
		}
		if (unstaged.stdout.trim()) {
			sections.push(`未暂存改动：\n\n${unstaged.stdout.trim()}`);
		}

		// 3. 未跟踪文件：git diff 看不到，必须单独合成补丁
		const untracked = await collectUntrackedDiffs(cwd);
		if (untracked) {
			sections.push(untracked);
		}
	}

	if (!sections.length) {
		return "";
	}

	return truncateOutput(`待提交改动：\n\n${sections.join("\n\n")}`.trim(), GIT_DIFF_LINE_LIMIT);
}

/**
 * 把未跟踪文件逐个转成 `git diff --no-index` 的标准补丁，让提交信息生成能看到新建文件。
 * 注意：`--no-index` 发现差异时退出码是 1，属于正常结果，不是错误。
 */
async function collectUntrackedDiffs(cwd: string): Promise<string> {
	const listing = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (listing.failed) {
		// 未跟踪文件只是补充信息，读不到不影响主干 diff，记日志后跳过。
		console.warn("[Libiao Copilot] 读取未跟踪文件列表失败：", listing.stderr.trim());
		return "";
	}

	const files = listing.stdout.split("\0").filter((file) => file.trim().length > 0);
	if (!files.length) {
		return "";
	}

	const limited = files.slice(0, MAX_UNTRACKED_FILES);
	const parts: string[] = [];

	for (const file of limited) {
		const result = await runGit(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
		let patch = result.stdout.trim();
		if (!patch) {
			continue;
		}
		if (patch.length > MAX_SINGLE_FILE_DIFF_CHARS) {
			patch = `${patch.slice(0, MAX_SINGLE_FILE_DIFF_CHARS)}\n[...该文件 diff 过长，已截断...]`;
		}
		parts.push(patch);
	}

	if (!parts.length) {
		return "";
	}

	const omittedNote =
		files.length > limited.length
			? `\n\n[...另有 ${files.length - limited.length} 个未跟踪文件未纳入...]`
			: "";
	return `新增（未跟踪）文件：\n\n${parts.join("\n\n")}${omittedNote}`;
}

export async function getGitRemoteUrls(cwd: string): Promise<string[]> {
	try {
		const isInstalled = await checkGitInstalled();
		if (!isInstalled) {
			return [];
		}

		const isRepo = await checkGitRepo(cwd);
		if (!isRepo) {
			return [];
		}

		const { stdout } = await execAsync("git remote -v", { cwd });
		if (!stdout.trim()) {
			return [];
		}

		// Parse output to extract unique URLs
		// git remote -v output format: "remoteName remoteUrl (fetch|push)"
		const remotes = stdout
			.trim()
			.split("\n")
			.filter((line) => line.includes("(fetch)")) // Only fetch URLs to avoid duplicates
			.map((line) => {
				const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
				return match ? { name: match[1], url: match[2] } : null;
			})
			.filter((remote): remote is { name: string; url: string } => remote !== null);

		return remotes.map((remote) => `${remote.name}: ${remote.url}`);
	} catch (error) {
		console.error("Error getting git remotes:", error);
		return [];
	}
}

export async function getLatestGitCommitHash(cwd: string): Promise<string | null> {
	try {
		const isInstalled = await checkGitInstalled();
		if (!isInstalled) {
			return null;
		}

		const isRepo = await checkGitRepo(cwd);
		if (!isRepo) {
			return null;
		}

		const { stdout } = await execAsync("git rev-parse HEAD", { cwd });
		return stdout.trim() || null;
	} catch (error) {
		console.error("Error getting latest git commit hash:", error);
		return null;
	}
}

function truncateOutput(content: string, limit = GIT_OUTPUT_LINE_LIMIT): string {
	if (!limit) {
		return content;
	}

	const lines = content.split("\n");
	if (lines.length <= limit) {
		return content;
	}

	const beforeLimit = Math.floor(limit * 0.2); // 20% of lines before
	const afterLimit = limit - beforeLimit; // remaining 80% after
	return [
		...lines.slice(0, beforeLimit),
		`\n[...${lines.length - limit} lines omitted...]\n`,
		...lines.slice(-afterLimit),
	].join("\n");
}

// NEW: Additional functions for Stage 3 multi-workspace support
// These are the ONLY new additions needed for workspace detection

/**
 * Check if a directory is a Git repository (Stage 3 requirement)
 * @param dirPath - The directory path to check
 * @returns True if it's a Git repository
 */
export async function isGitRepository(dirPath: string): Promise<boolean> {
	return await checkGitRepo(dirPath);
}
