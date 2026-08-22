import * as assert from "assert";
import { SessionStats, isNewSession } from "../sessionStats";

/**
 * 会话统计模块单元测试。
 * 覆盖：记录累计、思考 token、usage 缺失跳过、会话边界检测、tooltip 格式化。
 */
suite("sessionStats", () => {
	test("recordRequest 累计：同模型多次请求累加 token 与耗时", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000);
		stats.recordRequest("m1", { completion_tokens: 50 }, 1000);

		const entry = stats.get("m1");
		assert.ok(entry);
		assert.strictEqual(entry.requests, 2);
		assert.strictEqual(entry.outputTokens, 150);
		assert.strictEqual(entry.totalStreamMs, 3000);
	});

	test("reasoning_tokens：累加思考 token（从 completion_tokens_details 读取）", () => {
		const stats = new SessionStats();
		stats.recordRequest(
			"m1",
			{
				completion_tokens: 200,
				completion_tokens_details: { reasoning_tokens: 150 },
			},
			5000
		);
		stats.recordRequest(
			"m1",
			{
				completion_tokens: 300,
				completion_tokens_details: { reasoning_tokens: 200 },
			},
			6000
		);

		const entry = stats.get("m1");
		assert.ok(entry);
		assert.strictEqual(entry.reasoningTokens, 350);
		// 思考占比 = 350 / 500 = 70%
	});

	test("usage 缺失或 completion_tokens<=0：跳过不累计", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", null, 2000);
		stats.recordRequest("m1", undefined, 2000);
		stats.recordRequest("m1", { completion_tokens: 0 }, 2000);

		assert.strictEqual(stats.get("m1"), null);
	});

	test("streamMs 缺失或 <=0：不累计耗时但累计 token", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, null);
		stats.recordRequest("m1", { completion_tokens: 100 }, 0);

		const entry = stats.get("m1");
		assert.ok(entry);
		assert.strictEqual(entry.outputTokens, 200);
		assert.strictEqual(entry.totalStreamMs, 0);
	});

	test("reset：清空所有模型统计", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000);
		stats.recordRequest("m2", { completion_tokens: 50 }, 1000);
		stats.reset();

		assert.strictEqual(stats.get("m1"), null);
		assert.strictEqual(stats.get("m2"), null);
		assert.strictEqual(stats.formatTooltip(), "");
	});

	test("多模型分别累计", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000);
		stats.recordRequest("m2", { completion_tokens: 50 }, 1000);

		const e1 = stats.get("m1");
		const e2 = stats.get("m2");
		assert.ok(e1 && e2);
		assert.strictEqual(e1.requests, 1);
		assert.strictEqual(e2.requests, 1);
	});

	test("isNewSession：消息条数减少超过一半视为新会话", () => {
		assert.strictEqual(isNewSession(10, 4), true); // 10 → 4，减少 60%
		assert.strictEqual(isNewSession(10, 5), false); // 10 → 5，恰好一半（默认阈值 0.5，需严格小于）
		assert.strictEqual(isNewSession(10, 9), false); // 正常增长
		assert.strictEqual(isNewSession(10, 11), false); // 增长不触发
		assert.strictEqual(isNewSession(null, 5), false); // 首次无基线
	});

	test("isNewSession：自定义阈值", () => {
		assert.strictEqual(isNewSession(10, 7, 0.2), true); // 10 → 7，减少 30% > 20%
		assert.strictEqual(isNewSession(10, 8, 0.2), false); // 10 → 8，恰好 20%，不触发（严格小于）
		assert.strictEqual(isNewSession(10, 8), false); // 默认 0.5 不触发
	});

	test("formatTooltip：无记录返回空字符串", () => {
		const stats = new SessionStats();
		assert.strictEqual(stats.formatTooltip(), "");
	});

	test("formatTooltip：单模型显示统计信息（多行格式）", () => {
		const stats = new SessionStats();
		stats.recordRequest(
			"qwen3.8-max",
			{
				completion_tokens: 181,
				completion_tokens_details: { reasoning_tokens: 150 },
			},
			4000
		);
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("会话统计 qwen3.8-max"), `应包含模型标题, got: ${tip}`);
		assert.ok(tip.includes("请求次数: 1"), `应包含请求数, got: ${tip}`);
		assert.ok(tip.includes("总输出: 181"), `应包含总输出, got: ${tip}`);
		assert.ok(tip.includes("思考 token 数: 150（83%）"), `应包含思考 token 数与占比, got: ${tip}`);
		assert.ok(tip.includes("正文 token 数: 31（17%）"), `应包含正文 token 数与占比, got: ${tip}`);
		assert.ok(tip.includes("流式耗时: 4 秒"), `应包含流式耗时, got: ${tip}`);
		assert.ok(tip.includes("平均速度: 45 token/秒"), `应包含平均速度, got: ${tip}`);
	});

	test("formatTooltip：长时间累计格式化为分秒", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 200 }, 125000); // 125 秒
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("流式耗时: 2 分 5 秒"), `应包含分秒格式, got: ${tip}`);
	});

	test("formatTooltip：无思考信息时不显示思考占比", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000);
		const tip = stats.formatTooltip();
		assert.ok(!tip.includes("思考"), `无思考信息不应显示占比, got: ${tip}`);
	});
});
