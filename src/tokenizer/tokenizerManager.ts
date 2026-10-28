import * as vscode from "vscode";
import { TikTokenizer, createTokenizer, getRegexByEncoder, getSpecialTokensByEncoder } from "@microsoft/tiktokenizer";

const TOKENIZER_ENCODER = "o200k_base";
const CACHE_MAX_ENTRIES = 5000;
const CACHE_MAX_SIZE_BYTES = 5_000_000; // 5MB

// Simple LRU Cache for token counts
// 导出仅供单元测试构造小容量实例
export class TokenCache {
	private cache = new Map<string, number>();
	private currentSize = 0;

	constructor(
		private readonly maxSize = CACHE_MAX_ENTRIES,
		private readonly maxSizeBytes = CACHE_MAX_SIZE_BYTES
	) {}

	/** 近似字节数：按 2 字节/字符，另加 Map 条目自身开销。 */
	private static estimateSize(key: string): number {
		return key.length * 2 + 8;
	}

	get(key: string): number | undefined {
		const value = this.cache.get(key);
		if (value !== undefined) {
			// Move to end (most recently used)
			this.cache.delete(key);
			this.cache.set(key, value);
		}
		return value;
	}

	set(key: string, value: number): void {
		const entrySize = TokenCache.estimateSize(key);

		// 单条就超过总容量上限时不入缓存：否则淘汰循环会清空整个缓存，
		// 而该条目仍被写入，currentSize 从此永久超限，之后每次 set 都要清空一遍缓存。
		if (entrySize > this.maxSizeBytes) {
			return;
		}

		// 同 key 覆盖时先释放旧条目，避免重复累计占用
		if (this.cache.has(key)) {
			this.cache.delete(key);
			this.currentSize -= entrySize;
		}

		// Evict if would exceed limits
		while (
			(this.cache.size >= this.maxSize || this.currentSize + entrySize > this.maxSizeBytes) &&
			this.cache.size > 0
		) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey === undefined) {
				break;
			}
			this.cache.delete(firstKey);
			this.currentSize -= TokenCache.estimateSize(firstKey);
		}

		this.cache.set(key, value);
		this.currentSize += entrySize;
	}
}

// Tokenizer singleton
export class TokenizerManager {
	private static instance: TokenizerManager | null = null;
	private tokenizer: TikTokenizer | null = null;
	private cache = new TokenCache();
	private tokenizerReady: Promise<TikTokenizer> | null = null;
	private static extensionPath: string | null = null;

	private constructor() {}

	/**
	 * Initialize the tokenizer with extension path (call from activate)
	 */
	static initialize(extensionPath: string): TokenizerManager {
		TokenizerManager.extensionPath = extensionPath;
		return TokenizerManager.getInstance();
	}

	static setExtensionPath(path: string): void {
		TokenizerManager.extensionPath = path;
	}

	static getInstance(): TokenizerManager {
		if (!TokenizerManager.instance) {
			TokenizerManager.instance = new TokenizerManager();
		}
		return TokenizerManager.instance;
	}

	async getTokenizer(): Promise<TikTokenizer> {
		if (this.tokenizer) {
			return this.tokenizer;
		}

		if (!this.tokenizerReady) {
			this.tokenizerReady = (async () => {
				if (!TokenizerManager.extensionPath) {
					throw new Error("Extension path not initialized. Call TokenizerManager.setExtensionPath() first.");
				}
				const basePath = vscode.Uri.file(TokenizerManager.extensionPath);
				const tokenizerPath = vscode.Uri.joinPath(basePath, "assets", "model", `${TOKENIZER_ENCODER}.tiktoken`).fsPath;
				return createTokenizer(
					tokenizerPath,
					getSpecialTokensByEncoder(TOKENIZER_ENCODER),
					getRegexByEncoder(TOKENIZER_ENCODER),
					64000
				);
			})();
		}

		this.tokenizer = await this.tokenizerReady;
		return this.tokenizer;
	}

	async countTokens(text: string): Promise<number> {
		if (!text) {
			return 0;
		}

		const cached = this.cache.get(text);
		if (cached !== undefined) {
			return cached;
		}

		const tokenizer = await this.getTokenizer();
		const tokens = tokenizer.encode(text);
		const count = tokens.length;

		this.cache.set(text, count);
		return count;
	}
}

// Export singleton instance
export const tokenizerManager = TokenizerManager.getInstance();
