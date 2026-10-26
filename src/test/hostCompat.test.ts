import * as assert from "assert";
import * as vscode from "vscode";

import {
	asRateLimitedError,
	collectToolResultText,
	getHostThinkingOverride,
	parseRetryAfterMs,
	withRetryAfter,
} from "../utils";

/**
 * 回归测试套件：宿主（Copilot Chat）新提案字段的兼容桥
 *
 * 红线：任何新符号都必须在旧宿主上安全降级，绝不抛错、绝不改变既有行为。
 */
suite("Host compatibility bridges", () => {
	suite("getHostThinkingOverride", () => {
		test("旧版宿主不下发 _enableThinking 时返回 undefined（保持插件自身配置）", () => {
			assert.strictEqual(getHostThinkingOverride(undefined), undefined);
			assert.strictEqual(getHostThinkingOverride({}), undefined);
			assert.strictEqual(getHostThinkingOverride({ modelOptions: {} }), undefined);
		});

		test("只接受布尔值，其它脏值一律忽略", () => {
			assert.strictEqual(getHostThinkingOverride({ modelOptions: { _enableThinking: "false" } }), undefined);
			assert.strictEqual(getHostThinkingOverride({ modelOptions: { _enableThinking: 0 } }), undefined);
			assert.strictEqual(getHostThinkingOverride({ modelOptions: { _enableThinking: null } }), undefined);
		});

		test("透传宿主下发的 true / false", () => {
			assert.strictEqual(getHostThinkingOverride({ modelOptions: { _enableThinking: false } }), false);
			assert.strictEqual(getHostThinkingOverride({ modelOptions: { _enableThinking: true } }), true);
		});
	});

	suite("parseRetryAfterMs / withRetryAfter", () => {
		test("解析秒数形式", () => {
			assert.strictEqual(parseRetryAfterMs("30"), 30_000);
			assert.strictEqual(parseRetryAfterMs("0"), 0);
			assert.strictEqual(parseRetryAfterMs(" 1.5 "), 1_500);
		});

		test("解析 HTTP 日期形式", () => {
			const future = new Date(Date.now() + 60_000).toUTCString();
			const parsed = parseRetryAfterMs(future);
			assert.ok(parsed !== undefined && parsed > 0 && parsed <= 60_000);
		});

		test("无法解析时返回 undefined", () => {
			assert.strictEqual(parseRetryAfterMs(undefined), undefined);
			assert.strictEqual(parseRetryAfterMs(null), undefined);
			assert.strictEqual(parseRetryAfterMs(""), undefined);
			assert.strictEqual(parseRetryAfterMs("not-a-date"), undefined);
			assert.strictEqual(parseRetryAfterMs("-5"), undefined);
		});

		test("withRetryAfter 把 Retry-After 挂到错误对象上", () => {
			const err = new Error("boom");
			const res = { headers: new Headers({ "retry-after": "12" }) } as unknown as Response;

			const decorated = withRetryAfter(err, res) as Error & { retryAfterMs?: number };
			assert.strictEqual(decorated, err, "必须返回同一个错误对象");
			assert.strictEqual(decorated.retryAfterMs, 12_000);
		});

		test("缺少响应或响应头时原样返回", () => {
			const err = new Error("boom");
			assert.strictEqual(withRetryAfter(err, undefined), err);
			assert.strictEqual((err as Error & { retryAfterMs?: number }).retryAfterMs, undefined);
		});
	});

	suite("asRateLimitedError", () => {
		test("非 429 错误原样返回", () => {
			const err = new Error("OAI Compatible API error: [500] internal\nURL: x");
			assert.strictEqual(asRateLimitedError(err), err);
		});

		test("429 时保留原错误信息，并在宿主支持时包装成 RateLimited", () => {
			const err = new Error("OAI Compatible API error: [429] Too Many Requests\nURL: x");
			const wrapped = asRateLimitedError(err) as Error;
			assert.strictEqual(wrapped.message, err.message, "错误信息必须保留");

			const hasFactory =
				typeof (vscode.LanguageModelError as unknown as { RateLimited?: unknown }).RateLimited === "function";
			if (hasFactory) {
				assert.strictEqual(wrapped.name, "LanguageModelError", "新宿主上应包装成 LanguageModelError.RateLimited");
				assert.strictEqual((wrapped as unknown as { code?: string }).code, "RateLimited");
			} else {
				assert.strictEqual(wrapped, err, "旧宿主没有该静态方法时必须原样抛出");
			}
		});

		test("非 Error 输入也能安全包装", () => {
			const wrapped = asRateLimitedError("something bad") as Error;
			assert.ok(wrapped instanceof Error);
			assert.strictEqual(wrapped.message, "something bad");
		});
	});

	suite("collectToolResultText", () => {
		test("二进制 DataPart 只留占位符，绝不把字节数组展开成数字表", () => {
			// 一张 2x2 PNG 的魔数即可：旧实现会让 JSON.stringify 输出 {"0":137,"1":80,...}
			const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const text = collectToolResultText({
				content: [new vscode.LanguageModelTextPart("截图如下："), new vscode.LanguageModelDataPart(png, "image/png")],
			});

			assert.ok(text.startsWith("截图如下："));
			assert.ok(text.includes("image/png"), `应带 MIME 占位符，实际: ${text}`);
			assert.ok(!text.includes('"0"'), `不得展开字节数组，实际: ${text}`);
			assert.ok(text.length < 200, `输出必须保持紧凑，实际长度: ${text.length}`);
		});

		test("cache_control 传输层标记被丢弃", () => {
			const cc = new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify({ type: "ephemeral" })),
				"cache_control"
			);
			const text = collectToolResultText({
				content: [new vscode.LanguageModelTextPart("结果"), cc],
			});
			assert.strictEqual(text, "结果");
		});

		test("字符串与文本分片正常拼接", () => {
			const text = collectToolResultText({
				content: ["a", new vscode.LanguageModelTextPart("b")],
			});
			assert.strictEqual(text, "ab");
		});
	});
});
