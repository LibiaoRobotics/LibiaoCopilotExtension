import * as assert from "assert";
import { planQuestionAnswers } from "../wechatBridgeAnswers";
import type { PendingInteraction, PendingQuestion } from "../wechatBridgeInteractions";

/**
 * 这组断言守的是「手机上回的编号能不能变成真正的答案」。
 *
 * 背景：提问未答时往对话注入任何消息，chatWidget 会 cancelCurrentRequestForSession
 * 并把轮播 dismiss(undefined) —— 提问被跳过、消息变成新请求。所以解析必须发生在注入
 * 之前，而且解析不了时只能回提示，绝不能退回注入。
 */
suite("企微回复转提问答案", () => {
	test("单选题回编号 → selectedValue 用原始 label，键是 resolveId:index", () => {
		const plan = planQuestionAnswers(single(), "2");
		assert.strictEqual(plan.kind, "answers");
		if (plan.kind !== "answers") {
			return;
		}
		assert.deepStrictEqual(plan.answers, { "call_x:0": { selectedValue: "测试" } });
		assert.ok(plan.summary.includes("测试"));
	});

	test("多选题回多个编号 → selectedValues 按回复顺序", () => {
		const plan = planQuestionAnswers(multi(), "1, 3");
		assert.strictEqual(plan.kind, "answers");
		if (plan.kind !== "answers") {
			return;
		}
		assert.deepStrictEqual(plan.answers, { "call_m:0": { selectedValues: ["A", "C"] } });
	});

	test("单选题回两个编号是错的，必须回提示而不是随便挑一个", () => {
		const plan = planQuestionAnswers(single(), "1 2");
		assert.strictEqual(plan.kind, "hint");
	});

	test("编号越界回提示，不静默改成其它选项", () => {
		assert.strictEqual(planQuestionAnswers(single(), "9").kind, "hint");
		assert.strictEqual(planQuestionAnswers(single(), "0").kind, "hint");
	});

	test("跳过词走 skip，答案传 undefined 等于全部略过", () => {
		assert.strictEqual(planQuestionAnswers(single(), "跳过").kind, "skip");
		assert.strictEqual(planQuestionAnswers(single(), "SKIP").kind, "skip");
	});

	test("单选题里的自由文本 → freeformValue", () => {
		const plan = planQuestionAnswers(single(), "部署到预发");
		assert.strictEqual(plan.kind, "answers");
		if (plan.kind !== "answers") {
			return;
		}
		assert.deepStrictEqual(plan.answers, { "call_x:0": { freeformValue: "部署到预发" } });
	});

	test("无选项的纯文本题把整条消息当答案", () => {
		const interaction = make({ index: 0, header: "", text: "分支名？", options: [], multiSelect: false });
		const plan = planQuestionAnswers(interaction, "feature/a");
		assert.strictEqual(plan.kind, "answers");
		if (plan.kind !== "answers") {
			return;
		}
		assert.deepStrictEqual(plan.answers, { "call_x:0": "feature/a" });
	});

	test("多问题要按顺序给全，数量和下标都要对上", () => {
		const interaction: PendingInteraction = {
			sessionId: "s",
			toolCallId: "call_q__vscode-1",
			resolveId: "call_q",
			markdown: "",
			questions: [
				{ index: 0, header: "环境", text: "哪个环境？", options: [{ label: "生产", description: "" }], multiSelect: false },
				{ index: 1, header: "分支", text: "哪个分支？", options: [{ label: "main", description: "" }, { label: "dev", description: "" }], multiSelect: false },
			],
		};
		const plan = planQuestionAnswers(interaction, "1 2");
		assert.strictEqual(plan.kind, "answers");
		if (plan.kind !== "answers") {
			return;
		}
		assert.deepStrictEqual(plan.answers, {
			"call_q:0": { selectedValue: "生产" },
			"call_q:1": { selectedValue: "dev" },
		});
		assert.strictEqual(planQuestionAnswers(interaction, "1").kind, "hint");
		assert.strictEqual(planQuestionAnswers(interaction, "1 9").kind, "hint");
	});

	test("含多选题的多问题回提示，不猜用户的意图", () => {
		const interaction: PendingInteraction = {
			sessionId: "s",
			toolCallId: "call_q",
			resolveId: "call_q",
			markdown: "",
			questions: [
				{ index: 0, header: "", text: "一", options: [{ label: "A", description: "" }], multiSelect: false },
				{ index: 1, header: "", text: "二", options: [{ label: "B", description: "" }], multiSelect: true },
			],
		};
		assert.strictEqual(planQuestionAnswers(interaction, "1 1").kind, "hint");
	});

	test("空提问列表不崩，只回提示", () => {
		const interaction: PendingInteraction = {
			sessionId: "s",
			toolCallId: "call_e",
			resolveId: "call_e",
			markdown: "",
			questions: [],
		};
		assert.strictEqual(planQuestionAnswers(interaction, "1").kind, "hint");
	});
});

function single(): PendingInteraction {
	return make(
		{
			index: 0,
			header: "目标环境",
			text: "部署到哪个环境？",
			options: [
				{ label: "生产", description: "" },
				{ label: "测试", description: "先试一下" },
			],
			multiSelect: false,
		},
		"call_x"
	);
}

function multi(): PendingInteraction {
	return make(
		{
			index: 0,
			header: "",
			text: "要跑哪些？",
			options: [
				{ label: "A", description: "" },
				{ label: "B", description: "" },
				{ label: "C", description: "" },
			],
			multiSelect: true,
		},
		"call_m"
	);
}

function make(question: PendingQuestion, resolveId = "call_x"): PendingInteraction {
	return {
		sessionId: "s",
		toolCallId: `${resolveId}__vscode-1`,
		resolveId,
		markdown: "",
		questions: [question],
	};
}
