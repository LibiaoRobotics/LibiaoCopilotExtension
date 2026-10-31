/**
 * 多窗口互斥租约。
 *
 * 企微只允许同一个机器人存在**一条**有效长连接：新连接订阅会把旧连接踢掉，
 * 而每个 VS Code 窗口都有独立的扩展宿主，都会执行 activate。
 * 若不做选主，两个窗口会互相踢对方并无限重连。
 *
 * 不能用 globalState：它在本窗口进程内有缓存，别的窗口写入后本窗口读不到。
 * 所以用 globalStorage 目录下的一个文件做租约，靠心跳时间戳判断陈旧。
 *
 * 假设/局限：文件写入不是原子的跨进程锁，极端并发下可能两个窗口同时觉得自己是主。
 * 兜底是服务层监听 disconnected_event 并立即停止重连，避免形成踢人风暴。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_FILE_NAME = "wechatBridgeLease.json";

/** 超过这个时间没有心跳就认为原主已消失 */
export const WECHAT_BRIDGE_LEASE_STALE_MS = 60_000;

/** 心跳间隔，必须明显小于陈旧阈值 */
export const WECHAT_BRIDGE_LEASE_HEARTBEAT_MS = 15_000;

export interface WechatBridgeLeaseRecord {
	ownerId: string;
	workspaceName: string;
	heartbeatAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export class WechatBridgeLease {
	readonly ownerId = randomBytes(8).toString("hex");
	private readonly filePath: string;

	constructor(directory: string, private readonly workspaceName: string) {
		this.filePath = path.join(directory, LEASE_FILE_NAME);
	}

	read(): WechatBridgeLeaseRecord | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, "utf8");
		} catch {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		const record = asRecord(parsed);
		if (!record || typeof record.ownerId !== "string" || typeof record.heartbeatAt !== "number") {
			return undefined;
		}
		return {
			ownerId: record.ownerId,
			workspaceName: typeof record.workspaceName === "string" ? record.workspaceName : "",
			heartbeatAt: record.heartbeatAt,
		};
	}

	private isFree(record: WechatBridgeLeaseRecord | undefined, now: number): boolean {
		return !record || record.ownerId === this.ownerId || now - record.heartbeatAt > WECHAT_BRIDGE_LEASE_STALE_MS;
	}

	/** 抢占或续租；返回 false 表示别的窗口正持有 */
	tryAcquire(now = Date.now()): boolean {
		const record = this.read();
		if (!this.isFree(record, now)) {
			return false;
		}
		return this.write(now);
	}

	/** 心跳：只在自己是主时续期 */
	renew(now = Date.now()): boolean {
		const record = this.read();
		if (record && record.ownerId !== this.ownerId) {
			return false;
		}
		return this.write(now);
	}

	release(): void {
		const record = this.read();
		if (record && record.ownerId !== this.ownerId) {
			return;
		}
		try {
			fs.rmSync(this.filePath, { force: true });
		} catch {
			// 删不掉也不影响对方：心跳超时后租约会自然失效
		}
	}

	/** 当前持有者描述（不含自己），用于界面提示 */
	describeHolder(now = Date.now()): string | undefined {
		const record = this.read();
		if (!record || record.ownerId === this.ownerId || now - record.heartbeatAt > WECHAT_BRIDGE_LEASE_STALE_MS) {
			return undefined;
		}
		return record.workspaceName || "另一个 VS Code 窗口";
	}

	private write(now: number): boolean {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			const record: WechatBridgeLeaseRecord = {
				ownerId: this.ownerId,
				workspaceName: this.workspaceName,
				heartbeatAt: now,
			};
			const tempPath = `${this.filePath}.${this.ownerId}.tmp`;
			fs.writeFileSync(tempPath, JSON.stringify(record), "utf8");
			fs.renameSync(tempPath, this.filePath);
			return true;
		} catch {
			// 写不了租约文件时宁可判定为失败：宁可不连，也不要多窗口互踢
			return false;
		}
	}
}
