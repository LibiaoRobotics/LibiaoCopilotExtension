import * as assert from "assert";
import { TokenCache } from "../tokenizer/tokenizerManager";

/**
 * TokenCache 的回归测试。
 *
 * 核心红线：单条超过字节上限的 key 必须被拒绝缓存。旧实现会在淘汰循环里
 * 清空整个缓存后仍然写入该条目，使 currentSize 永久超限，
 * 之后每次 set 都要清空一遍缓存——缓存等于失效，且每次都付出全量淘汰的代价。
 */
suite("tokenCache", () => {
	// 与实现保持一致的近似口径：2 字节/字符 + 8 字节条目开销
	const entrySize = (key: string) => key.length * 2 + 8;

	test("超出字节上限的单条 key 不入缓存，且不会清空已有条目", () => {
		const cache = new TokenCache(10, 100);
		cache.set("a", 1);

		const hugeKey = "x".repeat(50);
		assert.ok(entrySize(hugeKey) > 100, "前提：该 key 单条即超过上限");

		cache.set(hugeKey, 999);

		assert.strictEqual(cache.get(hugeKey), undefined, "超大 key 不应被写入缓存");
		assert.strictEqual(cache.get("a"), 1, "已有的正常条目不应被牵连淘汰");
	});

	test("默认容量下，长文本 key 被拒绝缓存而不是撑爆缓存", () => {
		const cache = new TokenCache();
		cache.set("anchor", 1);

		// 5MB 上限下约 250 万字符即越界；真实场景中一张截图曾被 JSON 展开成 440 万字符
		const hugeKey = "x".repeat(2_500_001);
		cache.set(hugeKey, 1_255_599);

		assert.strictEqual(cache.get(hugeKey), undefined);
		assert.strictEqual(cache.get("anchor"), 1);
	});

	test("同 key 重复写入不会重复累计占用，不会挤掉其他条目", () => {
		const cache = new TokenCache(100, 1000);
		cache.set("anchor", 1);

		for (let i = 0; i < 200; i++) {
			cache.set("dup", i);
		}

		assert.strictEqual(cache.get("anchor"), 1, "重复写入同一 key 不应触发淘汰");
		assert.strictEqual(cache.get("dup"), 199);
	});

	test("超过条数上限时淘汰最久未使用的条目", () => {
		const cache = new TokenCache(2, 1_000_000);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);

		assert.strictEqual(cache.get("a"), undefined);
		assert.strictEqual(cache.get("b"), 2);
		assert.strictEqual(cache.get("c"), 3);
	});
});
