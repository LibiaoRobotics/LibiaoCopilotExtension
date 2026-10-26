import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

type LogLevel = "off" | "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	off: -1,
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LOG_RETENTION_DAYS = 7;
const SENSITIVE_HEADER_KEYS = ["Authorization", "x-api-key", "x-goog-api-key"];
// Debug 级别下流式 chunk 每秒可达数百条，逐条同步落盘会把扩展宿主主线程
// 钉在同步 I/O 上（实测一次请求可产生数千次 appendFileSync），导致 SSE 数据
// 在 socket 缓冲区堆积、界面卡住后一次性刷出。改为内存聚合后批量异步写入。
const FLUSH_INTERVAL_MS = 200;
const FLUSH_BYTES = 256 * 1024;

class Logger {
	private _level: LogLevel = "off";
	private _logDir = "";
	private _initialized = false;
	private _buffer: string[] = [];
	private _bufferBytes = 0;
	private _flushTimer: ReturnType<typeof setTimeout> | null = null;
	private _flushing = false;

	/**
	 * Initialize the logger: read config, ensure log directory exists.
	 */
	init(): void {
		this._logDir = path.join(os.homedir(), ".copilot", "libiao-copilot", "logs");
		this.reloadConfig();
		this.ensureLogDir();
		this._initialized = true;
		// 过期清理只需在启动时做一次；原先放在 write() 里等于每条日志都扫一遍目录。
		this.cleanOldLogs();
	}

	/**
	 * Reload log level from VS Code configuration.
	 */
	reloadConfig(): void {
		const config = vscode.workspace.getConfiguration();
		this._level = config.get<LogLevel>("libiaoCopilot.logLevel", "off");
	}

	debug(tag: string, data: Record<string, unknown>): void {
		if (this._level === "off" || LOG_LEVEL_PRIORITY[this._level] > LOG_LEVEL_PRIORITY.debug) {
			return;
		}
		this.write("debug", tag, data);
	}

	info(tag: string, data: Record<string, unknown>): void {
		if (this._level === "off" || LOG_LEVEL_PRIORITY[this._level] > LOG_LEVEL_PRIORITY.info) {
			return;
		}
		this.write("info", tag, data);
	}

	warn(tag: string, data: Record<string, unknown>): void {
		if (this._level === "off" || LOG_LEVEL_PRIORITY[this._level] > LOG_LEVEL_PRIORITY.warn) {
			return;
		}
		this.write("warn", tag, data);
	}

	error(tag: string, data: Record<string, unknown>): void {
		if (this._level === "off" || LOG_LEVEL_PRIORITY[this._level] > LOG_LEVEL_PRIORITY.error) {
			return;
		}
		this.write("error", tag, data);
	}

	/**
	 * Sanitize sensitive headers: show only first 4 chars + "***" for auth-related keys.
	 */
	sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
		const sanitized: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (SENSITIVE_HEADER_KEYS.includes(key)) {
				// Extract the token part after "Bearer " if present
				const tokenPrefix = value.startsWith("Bearer ") ? "Bearer " : "";
				const token = value.startsWith("Bearer ") ? value.slice(7) : value;
				if (token.length <= 4) {
					sanitized[key] = tokenPrefix + "***";
				} else {
					sanitized[key] = tokenPrefix + token.slice(0, 4) + "***";
				}
			} else {
				sanitized[key] = value;
			}
		}
		return sanitized;
	}

	/**
	 * Sanitize any object that may contain headers deeply.
	 * Looks for "headers" keys at any level and sanitates them.
	 */
	sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (key === "headers" && value && typeof value === "object" && !Array.isArray(value)) {
				result[key] = this.sanitizeHeaders(value as Record<string, string>);
			} else if (value && typeof value === "object" && !Array.isArray(value)) {
				result[key] = this.sanitizeData(value as Record<string, unknown>);
			} else {
				result[key] = value;
			}
		}
		return result;
	}

	private ensureLogDir(): void {
		if (!fs.existsSync(this._logDir)) {
			fs.mkdirSync(this._logDir, { recursive: true });
		}
	}

	private getLogFilePath(): string {
		const now = new Date();
		const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
		return path.join(this._logDir, `libiao-copilot-${dateStr}.log`);
	}

	private write(level: string, tag: string, data: Record<string, unknown>): void {
		if (!this._initialized) {
			return;
		}

		const line = `${JSON.stringify({
			ts: new Date().toISOString(),
			level,
			tag,
			data: this.sanitizeData(data),
		})}\n`;

		this._buffer.push(line);
		this._bufferBytes += Buffer.byteLength(line, "utf8");
		if (this._bufferBytes >= FLUSH_BYTES) {
			void this.flush();
			return;
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this._flushTimer) {
			return;
		}
		this._flushTimer = setTimeout(() => {
			this._flushTimer = null;
			void this.flush();
		}, FLUSH_INTERVAL_MS);
		this._flushTimer.unref?.();
	}

	/**
	 * Write buffered lines to disk asynchronously.
	 */
	async flush(): Promise<void> {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = null;
		}
		if (this._flushing) {
			this.scheduleFlush();
			return;
		}
		if (this._buffer.length === 0) {
			return;
		}

		this._flushing = true;
		const payload = this._buffer.join("");
		this._buffer = [];
		this._bufferBytes = 0;
		try {
			await fs.promises.appendFile(this.getLogFilePath(), payload, "utf8");
		} catch (e) {
			console.error("[Libiao Copilot Logger] Failed to write log:", e);
		} finally {
			this._flushing = false;
		}
	}

	/**
	 * Synchronously drain the buffer. Used from deactivate() where a pending
	 * async flush would not survive process teardown.
	 */
	flushSync(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = null;
		}
		if (this._buffer.length === 0) {
			return;
		}

		const payload = this._buffer.join("");
		this._buffer = [];
		this._bufferBytes = 0;
		try {
			fs.appendFileSync(this.getLogFilePath(), payload, "utf8");
		} catch (e) {
			console.error("[Libiao Copilot Logger] Failed to write log:", e);
		}
	}

	private cleanOldLogs(): void {
		try {
			if (!fs.existsSync(this._logDir)) {
				return;
			}

			const files = fs.readdirSync(this._logDir);
			const now = new Date();
			const cutoffTime = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

			for (const file of files) {
				// Extract date from filename: libiao-copilot-YYYYMMDD.log
				const match = file.match(/^libiao-copilot-(\d{4})(\d{2})(\d{2})\.log$/);
				if (!match) {
					continue;
				}

				const year = parseInt(match[1], 10);
				const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
				const day = parseInt(match[3], 10);
				const fileDate = new Date(year, month, day);

				if (fileDate.getTime() < cutoffTime) {
					const filePath = path.join(this._logDir, file);
					fs.unlinkSync(filePath);
				}
			}
		} catch (e) {
			console.error("[Libiao Copilot Logger] Failed to clean old logs:", e);
		}
	}
}

export const logger = new Logger();
