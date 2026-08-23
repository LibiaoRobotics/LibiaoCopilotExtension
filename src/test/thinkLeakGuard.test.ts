import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

// 回归测试（2026-08-23 思考跨通道泄漏事故）：
// qwen3.8-max 有时把思考后半续写到正文通道（无 <think> 开标签、以 </think>
// 自闭），旧解析器认不出无开标签的块 → 思考尾巴 + 闭标签漏进正文。
// 修复：reasoning 以失衡反引号收尾时对正文通道进入守卫模式——
// 见孤儿 </think> 则缓冲转思考 part、丢标签；超上限判误报 flush 为正文。
suite("openaiResponsesApi think leak guard", () => {
	function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
		const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload));
				controller.close();
			},
		});
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

	function recordingProgress(): { progress: vscode.Progress<vscode.LanguageModelResponsePart2>; parts: vscode.LanguageModelResponsePart2[] } {
		const parts: vscode.LanguageModelResponsePart2[] = [];
		return { progress: { report: (p) => parts.push(p) }, parts };
	}

	async function run(events: Record<string, unknown>[]) {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(sseStream(events), progress, token);
		return parts;
	}

	test("泄漏回合：思考尾巴转折叠区，正文干净无 </think>", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_lk1" } },
			// reasoning 以开反引号收尾（失衡）→ 守卫触发信号
			{ type: "response.reasoning_text.delta", delta: "checking the `", item_id: "msg_r", output_index: 0 },
			{ type: "response.reasoning_text.done", text: "checking the `", item_id: "msg_r", output_index: 0 },
			{ type: "response.output_item.added", output_index: 1, item: { id: "msg_m", type: "message" } },
			// 正文通道续写思考（无开标签）+ 孤儿闭标签 + 真正文
			{ type: "response.output_text.delta", delta: "`... but in that case the thinking leaks.", item_id: "msg_m", output_index: 1 },
			{ type: "response.output_text.delta", delta: "\n</think>\n\n特哥这个线索很重要。", item_id: "msg_m", output_index: 1 },
			{ type: "response.completed", response: { id: "resp_lk1" } },
		]);

		const text = collectText(parts);
		assert.ok(!text.includes("</think>"), `正文不应含闭标签, got: ${text}`);
		assert.ok(!text.includes("leaks"), `正文不应含思考尾巴, got: ${text}`);
		assert.ok(text.includes("特哥这个线索很重要"), `正文应含真正文, got: ${text}`);

		const thinking = collectThinking(parts);
		assert.ok(thinking.includes("the thinking leaks"), `泄漏段应补进思考折叠区, got: ${thinking}`);
	});

	test("正常回合（反引号平衡）：正文立即发射、无缓冲副作用", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_lk2" } },
			{ type: "response.reasoning_text.delta", delta: "balanced `code` span.", item_id: "msg_r", output_index: 0 },
			{ type: "response.output_item.added", output_index: 1, item: { id: "msg_m", type: "message" } },
			{ type: "response.output_text.delta", delta: "正常正文第一段。", item_id: "msg_m", output_index: 1 },
			{ type: "response.output_text.delta", delta: "第二段。", item_id: "msg_m", output_index: 1 },
			{ type: "response.completed", response: { id: "resp_lk2" } },
		]);

		assert.strictEqual(collectText(parts), "正常正文第一段。第二段。");
	});

	test("误报回合（失衡但无闭标签、超上限）：缓冲 flush 为正文不丢内容", async () => {
		const longBody = "正".repeat(2500);
		const parts = await run([
			{ type: "response.created", response: { id: "resp_lk3" } },
			{ type: "response.reasoning_text.delta", delta: "ends with `", item_id: "msg_r", output_index: 0 },
			{ type: "response.output_item.added", output_index: 1, item: { id: "msg_m", type: "message" } },
			{ type: "response.output_text.delta", delta: longBody.slice(0, 1000), item_id: "msg_m", output_index: 1 },
			{ type: "response.output_text.delta", delta: longBody.slice(1000), item_id: "msg_m", output_index: 1 },
			{ type: "response.completed", response: { id: "resp_lk3" } },
		]);

		assert.strictEqual(collectText(parts), longBody, "误报 flush 后正文应完整");
	});

	test("无 reasoning 的回合：守卫不触发", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_lk4" } },
			{ type: "response.output_item.added", output_index: 0, item: { id: "msg_m", type: "message" } },
			{ type: "response.output_text.delta", delta: "直接正文。", item_id: "msg_m", output_index: 0 },
			{ type: "response.completed", response: { id: "resp_lk4" } },
		]);

		assert.strictEqual(collectText(parts), "直接正文。");
	});

	test("守卫期内见开标签：退出守卫 flush 为正文（原生 reasoning 后标签按字面，2026-08-22 门控）", async () => {
		const parts = await run([
			{ type: "response.created", response: { id: "resp_lk5" } },
			{ type: "response.reasoning_text.delta", delta: "ends with `", item_id: "msg_r", output_index: 0 },
			{ type: "response.output_item.added", output_index: 1, item: { id: "msg_m", type: "message" } },
			{ type: "response.output_text.delta", delta: "前缀正文<think>思考内容</think>后正文", item_id: "msg_m", output_index: 1 },
			{ type: "response.completed", response: { id: "resp_lk5" } },
		]);

		// 守卫退出后缓冲整体走常规路径；原生 reasoning 已激活时 XML 标签按字面正文（既有门控语义）
		const text = collectText(parts);
		assert.ok(text.includes("前缀正文"), `got: ${text}`);
		assert.ok(text.includes("后正文"), `got: ${text}`);
	});
});
