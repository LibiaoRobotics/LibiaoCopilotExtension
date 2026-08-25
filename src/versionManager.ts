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
	 * Get the current extension version
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension =
				vscode.extensions.getExtension("libiaorobot.libiao-copilot") ||
				vscode.extensions.getExtension("johnny-zhao.oai-compatible-copilot");
			this._version = extension?.packageJSON?.version ?? "1.2.1";
		}
		return this._version!;
	}

	/**
	 * Get the extension packaging/build date (YYYY-MM-DD)
	 */
	static getBuildDate(): string {
		if (this._buildDate === null) {
			try {
				const extension =
					vscode.extensions.getExtension("libiaorobot.libiao-copilot") ||
					vscode.extensions.getExtension("johnny-zhao.oai-compatible-copilot");
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
