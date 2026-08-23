import * as assert from "assert";
import { SessionStats } from "../sessionStats";

/**
 * 会话统计模块单元测试。
 * 覆盖：记录累计、思考 token、usage 缺失跳过、显示名、tooltip 格式化。
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

	test("formatTooltip：无记录返回空字符串", () => {
		const stats = new SessionStats();
		assert.strictEqual(stats.formatTooltip(), "");
	});

	test("formatTooltip：单模型显示统计（标题+紧凑文本行）", () => {
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
		assert.ok(tip.includes("模型统计 · qwen3.8-max"), `应包含模型标题, got: ${tip}`);
		assert.ok(tip.includes("请求次数：`1`"), `应包含请求数, got: ${tip}`);
		assert.ok(tip.includes("输出 token：`181`"), `应包含总输出 token 数, got: ${tip}`);
		assert.ok(tip.includes("├ 思考（83%）：`150`"), `应包含思考 token 数与占比, got: ${tip}`);
		assert.ok(tip.includes("└ 正文（17%）：`31`"), `应包含正文 token 数与占比, got: ${tip}`);
		assert.ok(tip.includes("流式耗时：4 秒"), `应包含流式耗时, got: ${tip}`);
		assert.ok(tip.includes("$(info) 平均速度：**45** token/秒"), `应包含蓝色图标的平均速度行, got: ${tip}`);
	});

	test("recordRequest 传 displayName：标题显示 displayName（带视觉图标）而非组合 ID", () => {
		const stats = new SessionStats();
		// 🖼️ 用码点转义，避免编辑工具写坏 emoji
		const name = "\u{1F5BC}\uFE0F" + "Qwen 3.8 Max";
		stats.recordRequest(
			"qwen3.8-max::cfg1",
			{ completion_tokens: 100 },
			2000,
			name
		);
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("模型统计 · " + name), `应显示 displayName, got: ${tip}`);
		assert.ok(!tip.includes("qwen3.8-max::cfg1"), `不应显示组合 ID, got: ${tip}`);
	});

	test("recordRequest 未传 displayName：标题回退显示组合 ID", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1::cfg1", { completion_tokens: 100 }, 2000);
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("模型统计 · m1::cfg1"), `应回退模型 ID, got: ${tip}`);
	});

	test("displayName 变更：以最新配置为准", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000, "旧名字");
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000, "新名字");
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("模型统计 · 新名字"), `应显示最新名字, got: ${tip}`);
		assert.ok(!tip.includes("旧名字"), `不应显示旧名字, got: ${tip}`);
	});

	test("formatTooltip：长时间累计格式化为分秒", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 200 }, 125000); // 125 秒
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("流式耗时：2 分 5 秒"), `应包含分秒格式, got: ${tip}`);
	});

	test("formatTooltip：无思考信息时不显示思考占比", () => {
		const stats = new SessionStats();
		stats.recordRequest("m1", { completion_tokens: 100 }, 2000);
		const tip = stats.formatTooltip();
		assert.ok(!tip.includes("思考"), `无思考信息不应显示占比, got: ${tip}`);
	});

	test("formatTooltip：Gemini 模式仅按正文 token 计算平均速度", () => {
		const stats = new SessionStats();
		stats.recordRequest(
			"gemini-3.7-flash",
			{
				completion_tokens: 1000,
				completion_tokens_details: { reasoning_tokens: 700 }, // 正文 300
			},
			1000, // 正文耗时 1000ms
			"Gemini 3.7 Flash",
			"gemini"
		);
		const tip = stats.formatTooltip();
		assert.ok(tip.includes("输出 token：`1,000`"), `总输出仍应显示精确账单 1000, got: ${tip}`);
		assert.ok(tip.includes("├ 思考（70%）：`700`"), `应包含思考 token, got: ${tip}`);
		assert.ok(tip.includes("└ 正文（30%）：`300`"), `应包含正文 token, got: ${tip}`);
		// Gemini 速度仅按正文 300 / 1s = 300 t/s（而非 1000 t/s）
		assert.ok(tip.includes("$(info) 平均速度：**300** token/秒"), `Gemini 应按正文速度 300 计算, got: ${tip}`);
	});

	test("formatTooltip：非 Gemini 模式保持按总 token 计算平均速度", () => {
		const stats = new SessionStats();
		stats.recordRequest(
			"qwen-max",
			{
				completion_tokens: 1000,
				completion_tokens_details: { reasoning_tokens: 700 },
			},
			1000,
			"Qwen Max",
			"openai"
		);
		const tip = stats.formatTooltip();
		// 非 Gemini 模型保持原有逻辑：1000 / 1s = 1000 t/s
		assert.ok(tip.includes("$(info) 平均速度：**1000** token/秒"), `非 Gemini 保持原算法, got: ${tip}`);
	});
});
