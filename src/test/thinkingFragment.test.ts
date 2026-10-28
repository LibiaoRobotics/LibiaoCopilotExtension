import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

// 回归：网关会在正文中间插入几字到几十字的推理碎片（日志实测 89% 的
// reasoning 分片不足 20 字，而正文分片与之以 10~20ms 间隔交替近 2000 次）。
// 每上报一片碎片都会切断宿主对相邻 markdown 的合并，把一次回答炸成上千个
// response part，渲染器随即逐 part 全量重解析正文，表现为表格只渲染出几行、
// inline code 被撕成半截（2026-10-28 反馈）。
// 修法：首个思考序列照常上报，后续过短的序列静默抑制。
suite("thinking fragment suppression", () => {
	const FRAGMENT_THRESHOLD = 40;

	function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
		const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload));
				controller.close();
			},
		});
	}

	function recordingProgress(): {
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
		parts: vscode.LanguageModelResponsePart2[];
	} {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		return { progress: { report: (p) => parts.push(p) }, parts };
	}

	function collectText(parts: vscode.LanguageModelResponsePart2[]): string {
		return parts
			.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
			.map((p) => p.value)
			.join("");
	}

	function collectThinking(parts: vscode.LanguageModelResponsePart2[]): string {
		return parts
			.filter((p): p is vscode.LanguageModelThinkingPart => p instanceof vscode.LanguageModelThinkingPart)
			.map((p) => (Array.isArray(p.value) ? p.value.join("") : p.value))
			.join("");
	}

	/** 结束哨兵（{ vscode_reasoning_done: true }）的数量 = 上报过的思考序列数 */
	function countThinkingSequences(parts: vscode.LanguageModelResponsePart2[]): number {
		return parts.filter((p): p is vscode.LanguageModelThinkingPart => {
			if (!(p instanceof vscode.LanguageModelThinkingPart)) {
				return false;
			}
			const metadata = (p as unknown as { metadata?: Record<string, unknown> }).metadata;
			return metadata?.vscode_reasoning_done === true;
		}).length;
	}

	const LONG_REASONING = "先看清楚这个问题的边界，再决定从哪里入手。".repeat(3); // 超过阈值

	function reasoning(delta: string) {
		return { type: "response.reasoning_text.delta", delta };
	}

	function text(delta: string) {
		return { type: "response.output_text.delta", delta };
	}

	test("首段长思考照常上报，正文中间插入的短碎片被抑制", async () => {
		assert.ok(LONG_REASONING.length >= FRAGMENT_THRESHOLD, "测试前提：首段思考需超过抑制阈值");

		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;

		await api.processStreamingResponse(
			sseStream([
				{ type: "response.created", response: { id: "resp_frag1" } },
				reasoning(LONG_REASONING),
				{ type: "response.reasoning_text.done" },
				text("第一段正文"),
				reasoning("嗯"),
				{ type: "response.reasoning_text.done" },
				text("第二段正文"),
				reasoning("好"),
				{ type: "response.reasoning_text.done" },
				text("第三段正文"),
				{ type: "response.completed", response: { id: "resp_frag1" } },
			]),
			progress,
			token
		);

		assert.strictEqual(collectText(parts), "第一段正文第二段正文第三段正文", "正文内容必须完整且顺序不变");
		assert.strictEqual(collectThinking(parts), LONG_REASONING, "短碎片不应出现在思考内容里");
		assert.strictEqual(countThinkingSequences(parts), 1, "只应有一个思考序列被上报");
	});

	test("首个序列即使很短也照常上报（正常场景不丢思考）", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;

		await api.processStreamingResponse(
			sseStream([
				{ type: "response.created", response: { id: "resp_frag2" } },
				reasoning("短思考"),
				{ type: "response.reasoning_text.done" },
				text("正文"),
				{ type: "response.completed", response: { id: "resp_frag2" } },
			]),
			progress,
			token
		);

		assert.strictEqual(collectThinking(parts), "短思考", "首个思考序列不得被碎片抑制规则影响");
		assert.strictEqual(collectText(parts), "正文");
	});

	test("足够长的后续思考序列照常上报（多段真实思考不被误杀）", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;

		await api.processStreamingResponse(
			sseStream([
				{ type: "response.created", response: { id: "resp_frag3" } },
				reasoning(LONG_REASONING),
				{ type: "response.reasoning_text.done" },
				text("第一段正文"),
				reasoning(LONG_REASONING),
				{ type: "response.reasoning_text.done" },
				text("第二段正文"),
				{ type: "response.completed", response: { id: "resp_frag3" } },
			]),
			progress,
			token
		);

		assert.strictEqual(collectThinking(parts), LONG_REASONING + LONG_REASONING, "超过阈值的后续思考必须保留");
		assert.strictEqual(collectText(parts), "第一段正文第二段正文");
		assert.strictEqual(countThinkingSequences(parts), 2);
	});
});
