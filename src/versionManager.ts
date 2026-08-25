import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

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
