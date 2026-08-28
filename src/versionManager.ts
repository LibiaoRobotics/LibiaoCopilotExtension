import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_COMMIT_MODEL } from "./gitCommit/commitRecommendations";

/**
 * Format date to YYYY-MM-DD
 */
export function formatBuildDate(date: Date = new Date()): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	const YYYY = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const DD = pad(date.getDate());
	return `${YYYY}-${MM}-${DD}`;
}

export class VersionManager {
	private static _version: string | null = null;
	private static _buildDate: string | null = null;

	/**
	 * Get the current extension version dynamically from package.json (Single Source of Truth)
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension = vscode.extensions.getExtension("libiaorobot.libiao-copilot");
			if (extension?.packageJSON?.version) {
				this._version = extension.packageJSON.version;
			} else {
				// 兜底：在单测执行环境或本地开发宿主下动态定位并读取 package.json
				try {
					const candidates = [
						path.join(__dirname, "..", "package.json"),
						path.join(__dirname, "..", "..", "package.json"),
					];
					for (const cand of candidates) {
						if (fs.existsSync(cand)) {
							const pkg = JSON.parse(fs.readFileSync(cand, "utf-8"));
							if (pkg && typeof pkg.version === "string") {
								this._version = pkg.version;
								break;
							}
						}
					}
				} catch (err) {
					console.error("[libiaoCopilot] read package.json version error", err);
				}
			}
			if (!this._version) {
				this._version = "0.0.0";
			}
		}
		return this._version!;
	}

	/**
	 * Get the extension packaging/build date (YYYY-MM-DD)
	 */
	static getBuildDate(): string {
		if (this._buildDate === null) {
			try {
				const extension = vscode.extensions.getExtension("libiaorobot.libiao-copilot");
				if (extension) {
					const candidates = [
						path.join(extension.extensionPath, "out", "extension.js"),
						path.join(extension.extensionPath, "package.json"),
					];
					for (const candidate of candidates) {
						if (fs.existsSync(candidate)) {
							const stat = fs.statSync(candidate);
							this._buildDate = formatBuildDate(stat.mtime);
							return this._buildDate;
						}
					}
				}
			} catch (err) {
				console.error("[libiaoCopilot] getBuildDate error", err);
			}

			try {
				if (typeof __dirname === "string" && fs.existsSync(__dirname)) {
					const stat = fs.statSync(__dirname);
					this._buildDate = formatBuildDate(stat.mtime);
					return this._buildDate;
				}
			} catch {
				// ignore
			}

			this._buildDate = formatBuildDate(new Date());
		}
		return this._buildDate;
	}

	/**
	 * Build a descriptive User-Agent to help quantify API usage
	 * Keep UA minimal: only extension version and VS Code version
	 */
	static getUserAgent(): string {
		const vscodeVersion = vscode.version;
		return `libiao-copilot/${this.getVersion()} VSCode/${vscodeVersion}`;
	}

	/**
	 * Get the current extension information
	 */
	static getClientInfo(): { name: string; version: string; author: string } {
		return {
			name: "libiao-copilot",
			version: this.getVersion(),
			author: "libiaorobot",
		};
	}
}

/**
 * 比较两个语义化版本号，若 v1 < v2 则返回 true
 */
export function isVersionOlder(v1: string, v2: string): boolean {
	const parse = (v: string) => {
		const clean = v.replace(/^v/, "");
		return clean.split(".").map((x) => parseInt(x, 10) || 0);
	};
	const [maj1 = 0, min1 = 0, pat1 = 0] = parse(v1);
	const [maj2 = 0, min2 = 0, pat2 = 0] = parse(v2);

	if (maj1 !== maj2) {
		return maj1 < maj2;
	}
	if (min1 !== min2) {
		return min1 < min2;
	}
	return pat1 < pat2;
}

/**
 * 插件激活时执行版本跃迁配置迁移 (One-time Version Migration via globalState)
 */
export async function runVersionMigrations(context: vscode.ExtensionContext): Promise<void> {
	const LAST_VERSION_KEY = "libiaoCopilot.lastVersion";
	const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
	const currentVersion = VersionManager.getVersion();

	try {
		// 1.2.5 版本迁移：老用户（<= 1.2.4）升级时，若 settings.json 中保存的是旧默认 commitModel (deepseek-v4-flash)，静默升级至首推模型
		if (!lastVersion || isVersionOlder(lastVersion, "1.2.5")) {
			const config = vscode.workspace.getConfiguration();
			const inspect = config.inspect<string>("libiaoCopilot.commitModel");
			const currentValue = inspect?.globalValue;

			if (currentValue === "deepseek-v4-flash") {
				await config.update("libiaoCopilot.commitModel", DEFAULT_COMMIT_MODEL, vscode.ConfigurationTarget.Global);
			}
		}
	} catch (err) {
		console.error("[libiaoCopilot] runVersionMigrations error", err);
	} finally {
		// 记录已完成迁移至当前版本，确保后续启动绝对不再重复触发，永久尊重用户后续的主动选择
		await context.globalState.update(LAST_VERSION_KEY, currentVersion);
	}
}

