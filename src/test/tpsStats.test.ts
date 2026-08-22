import * as assert from "assert";
import {
	TpsTracker,
	getCalibratedRatio,
	updateCalibratedRatio,
	resetCalibrationTable,
	isContentPart,
	extractPartText,
	DEFAULT_CHARS_PER_TOKEN,
} from "../tpsStats";

/**
 * TPS 统计模块单元测试。
 * 用注入时钟源（nowFn）模拟时间推进，不依赖真实定时器。
 */
suite("tpsStats", () => {
	/** 可手动推进的假时钟 */
	function fakeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
		let t = startMs;
		return {
			now: () => t,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	setup(() => {
		resetCalibrationTable();
	});

	suite("实时估算", () => {
		test("首个 delta 无跨度返回 null，第二个 delta 后返回估算", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);
			assert.strictEqual(tracker.currentEstimate(), null); // 无 delta 时为 null

			clock.advance(1000); // 第 1 秒收到 25 个字符
			tracker.recordDelta("x".repeat(25));
			// 窗口内只有刚 push 的 chunk，跨度=0，无法估算（下一个 delta 才有时长）
			assert.strictEqual(tracker.currentEstimate(), null);

			clock.advance(1000); // 第 2 秒再收到 25 个字符
			tracker.recordDelta("y".repeat(25));
			const est = tracker.currentEstimate();
			assert.ok(est !== null && est > 0, `estimate should be > 0, got ${est}`);
		});

		test("估算值 = 窗口字符 ÷ 校准系数 ÷ 窗口时长 × 1000", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);

			// t=1000 收到 25 字符，t=2000 再收 25 字符
			// 窗口 = [t1000, t2000]，跨度 1000ms，chars=50
			// 默认 2.5 字符/token => 20 token，估算 = 20 / 1s = 20 t/s
			clock.advance(1000);
			tracker.recordDelta("x".repeat(25));
			clock.advance(1000);
			tracker.recordDelta("y".repeat(25));
			assert.strictEqual(tracker.currentEstimate(), 20);
		});

		test("窗口剪枝：超过 TPS_WINDOW_MS 的旧 chunk 被剔除", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);

			clock.advance(1000);
			tracker.recordDelta("x".repeat(25)); // t=1000
			clock.advance(2000);
			tracker.recordDelta("y".repeat(25)); // t=3000（旧 chunk 恰好在窗口边界，保留）
			// 窗口 [t1000, t3000] 跨度 2000ms，chars=50 => 50/2.5=20 token / 2s = 10 t/s
			assert.strictEqual(tracker.currentEstimate(), 10);

			clock.advance(2001); // t=5001：窗口内所有旧 chunk 全部超窗被剪
			tracker.recordDelta("z".repeat(25));
			assert.strictEqual(tracker.currentEstimate(), null); // 只剩刚 push 的 chunk，无跨度
		});
	});

	suite("结算", () => {
		test("有 usage：tps = completion_tokens / 流式时长 × 1000，且回填 ttft/字符/校准比", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);

			clock.advance(500); // TTFT 500ms
			tracker.recordDelta("a".repeat(50)); // 50 字符
			clock.advance(500); // 流式时长 500ms
			tracker.recordDelta("b".repeat(50)); // 共 100 字符

			const result = tracker.finalize({ completion_tokens: 40 });
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.tps, 80); // 40 token / 0.5s
			assert.strictEqual(result.ttftMs, 500);
			assert.strictEqual(result.streamDurationMs, 500);
			assert.strictEqual(result.completionTokens, 40);
			assert.strictEqual(result.chars, 100);
			assert.strictEqual(result.calibratedRatio, 2.5); // 100 字符 / 40 token
		});

		test("无 usage：reason = no_usage，ok = false", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);
			clock.advance(100);
			tracker.recordDelta("hello");
			clock.advance(100); // 需要有流式跨度，否则走 no_usage_too_fast 分支
			tracker.recordDelta(" world");
			const result = tracker.finalize(null);
			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.reason, "no_usage");
		});

		test("全程无 delta：reason = no_delta", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);
			const result = tracker.finalize({ completion_tokens: 10 });
			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.reason, "no_delta");
		});

		test("onDone 回调收到结算结果", () => {
			const clock = fakeClock(0);
			const tracker = new TpsTracker("m1", 0, clock.now);
			clock.advance(100);
			tracker.recordDelta("hello");
			clock.advance(100);
			tracker.recordDelta("world");
			let doneResult: unknown = null;
			tracker.onDone((r) => {
				doneResult = r;
			});
			tracker.finalize({ completion_tokens: 2 });
			assert.ok(doneResult);
			assert.strictEqual((doneResult as { ok: boolean }).ok, true);
		});

		test("通过 finalize 的实测值更新校准表（EMA）", () => {
			const clock = fakeClock(0);
			// 第一个请求：char/token = 2.5
			const t1 = new TpsTracker("m1", 0, clock.now);
			clock.advance(100);
			t1.recordDelta("x".repeat(100));
			clock.advance(100);
			t1.recordDelta("y");
			t1.finalize({ completion_tokens: 40 }); // 101 字符 / 40 ≈ 2.525
			// 第二个请求：char/token = 1.5
			const t2 = new TpsTracker("m1", 0, clock.now);
			clock.advance(100);
			t2.recordDelta("x".repeat(30));
			clock.advance(100);
			t2.recordDelta("y");
			t2.finalize({ completion_tokens: 20 }); // 31 字符 / 20 ≈ 1.55
			// 样本数 >= 3 前仍用默认值
			assert.strictEqual(getCalibratedRatio("m1"), DEFAULT_CHARS_PER_TOKEN);
			// 第三个请求：char/token = 2.0
			const t3 = new TpsTracker("m1", 0, clock.now);
			clock.advance(100);
			t3.recordDelta("x".repeat(40));
			clock.advance(100);
			t3.recordDelta("y");
			t3.finalize({ completion_tokens: 20 }); // 41 字符 / 20 ≈ 2.05
			const ratio = getCalibratedRatio("m1");
			assert.notStrictEqual(ratio, DEFAULT_CHARS_PER_TOKEN);
			assert.ok(ratio > 0);
		});
	});

	suite("校准表", () => {
		test("默认值：无记录/样本不足时返回 DEFAULT_CHARS_PER_TOKEN", () => {
			assert.strictEqual(getCalibratedRatio("unknown-model"), DEFAULT_CHARS_PER_TOKEN);
			updateCalibratedRatio("m2", 2.0);
			assert.strictEqual(getCalibratedRatio("m2"), DEFAULT_CHARS_PER_TOKEN); // 样本 1 < 3
			updateCalibratedRatio("m2", 2.0);
			updateCalibratedRatio("m2", 2.0);
			assert.strictEqual(getCalibratedRatio("m2"), 2.0);
		});

		test("EMA：多次更新后数值向新样本靠拢", () => {
			updateCalibratedRatio("m3", 3.0);
			updateCalibratedRatio("m3", 3.0);
			updateCalibratedRatio("m3", 2.0); // EMA(alpha=0.3)：3*, 3*(0.7)+2*0.3=2.7
			// 第三次后 samples=3，ratio ≈ EMA(3.0, 3.0, 2.0)
			const ratio = getCalibratedRatio("m3");
			assert.ok(Math.abs(ratio - 2.7) < 0.01, `expected ~2.7, got ${ratio}`);
		});

		test("非法实测值（<=0）不入表", () => {
			updateCalibratedRatio("m4", 0);
			updateCalibratedRatio("m4", -1);
			assert.strictEqual(getCalibratedRatio("m4"), DEFAULT_CHARS_PER_TOKEN);
		});
	});

	suite("part 分类与文本提取", () => {
		test("TextPart 计入内容", () => {
			const part = { value: "Hello" };
			assert.strictEqual(isContentPart(part as never), true);
			assert.strictEqual(extractPartText(part as never), "Hello");
		});

		test("ThinkingPart（string[]）计入内容并拼接", () => {
			const part = { value: ["思考一", "思考二"] };
			assert.strictEqual(isContentPart(part as never), true);
			assert.strictEqual(extractPartText(part as never), "思考一思考二");
		});

		test("ToolCallPart（无 value）不算内容", () => {
			const part = { callId: "call_1", name: "tool", input: {} };
			assert.strictEqual(isContentPart(part as never), false);
			assert.strictEqual(extractPartText(part as never), "");
		});

		test("DataPart（有 mimeType）不算内容", () => {
			const part = { mimeType: "application/json", value: "x" };
			assert.strictEqual(isContentPart(part as never), false);
			assert.strictEqual(extractPartText(part as never), "");
		});

		test("空 value 不算内容", () => {
			assert.strictEqual(isContentPart({ value: "" } as never), true);
			assert.strictEqual(extractPartText({ value: "" } as never), "");
		});
	});
});
