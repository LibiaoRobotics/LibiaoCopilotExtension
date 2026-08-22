import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";

// Regression tests for the "reply shown twice" bug (2026-08-13):
// some gateways send an empty output_text.delta right before
// response.output_text.done. The empty delta used to reset _hasEmittedText,
// so the done-event fallback re-emitted the FULL message text on top of the
// already-streamed deltas, duplicating the whole reply in the UI.
suite("openaiResponsesApi output text dedup", () => {
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
			.map((p) => ("value" in p ? (p as vscode.LanguageModelTextPart).value : ""))
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

	test("does not re-emit full text when done event follows an empty trailing delta", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.created", response: { id: "resp_test1" } },
				{ type: "response.output_text.delta", delta: "Hello" },
				{ type: "response.output_text.delta", delta: " world" },
				{ type: "response.output_text.delta", delta: "" },
				{ type: "response.output_text.done", text: "Hello world" },
				{ type: "response.completed", response: { id: "resp_test1" } },
			]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), "Hello world");
	});

	test("still emits text when gateway only sends a done payload without deltas", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([{ type: "response.output_text.done", text: "Only done payload" }, { type: "response.completed" }]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), "Only done payload");
	});

	test("emits each delta once when there is no empty trailing delta", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "one" },
				{ type: "response.output_text.delta", delta: " two" },
				{ type: "response.output_text.done", text: "one two" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), "one two");
	});

	// 2026-08-15 fuse fix: deltas routed into XML think blocks never set the old
	// _hasEmittedText flag, so a replaying done event re-ran the full text
	// through think-block processing and duplicated the thinking content.
	test("does not duplicate thinking when deltas carry XML think blocks and done replays the full text", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		const full = "<think>internal reasoning</think>visible answer";
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "<think>internal" },
				{ type: "response.output_text.delta", delta: " reasoning</think>visible answer" },
				{ type: "response.output_text.delta", delta: "" },
				{ type: "response.output_text.done", text: full },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), "visible answer");
		assert.strictEqual(collectThinking(parts), "internal reasoning");
	});

	// 2026-08-15 processXmlThinkBlocks fix: text following </think> in the SAME
	// delta used to be dropped (the no-start-tag branch discarded the tail once
	// any XML had been processed in that chunk). Same across chunks.
	test("keeps text following a closing think tag, in one delta or across deltas", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		// same-delta tail
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "<think>step" },
				{ type: "response.output_text.delta", delta: " one</think>tail text" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectThinking(parts), "step one");
		assert.strictEqual(collectText(parts), "tail text");
	});

	// Plain text BEFORE <think> in the same delta must not be dropped either.
	test("keeps plain text preceding a think start tag in the same delta", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "before <think>inner</think>after" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), "before after");
		assert.strictEqual(collectThinking(parts), "inner");
	});

	// Fuse is monotonic per stream: once blown by any text delta, reasoning done
	// events must not replay full reasoning text either.
	test("does not duplicate reasoning when reasoning deltas streamed and done replays them", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.reasoning_summary_text.delta", delta: "step one, " },
				{ type: "response.reasoning_summary_text.delta", delta: "step two" },
				{ type: "response.reasoning_summary_text.delta", delta: "" },
				{ type: "response.reasoning_summary_text.done", text: "step one, step two" },
				{ type: "response.output_text.delta", delta: "Answer." },
				{ type: "response.output_text.done", text: "Answer." },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectThinking(parts), "step one, step two");
		assert.strictEqual(collectText(parts), "Answer.");
	});

	// Regression (2026-08-15 audit): thinking buffered via XML think blocks in
	// TEXT deltas must also blow the reasoning-done fuse — the old code dropped
	// the replay via _hasEmittedThinking set in bufferThinkingContent; the fuse
	// rewrite initially lost that protection and double-emitted the thinking.
	test("does not duplicate thinking when XML think blocks are followed by a reasoning done replay", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "<think>via xml</think>answer body" },
				{ type: "response.reasoning_summary_text.done", text: "via xml" },
				{ type: "response.output_text.done", text: "<think>via xml</think>answer body" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectThinking(parts), "via xml");
		assert.strictEqual(collectText(parts), "answer body");
	});

	// Pure-done gateways (no deltas at all) must keep working — the fuse only
	// blows after a delta is actually seen.
	test("still emits reasoning and text from done events when no deltas were sent", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.reasoning_summary_text.done", text: "lone reasoning" },
				{ type: "response.output_text.done", text: "lone answer" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectThinking(parts), "lone reasoning");
		assert.strictEqual(collectText(parts), "lone answer");
	});

	// 2026-08-23 换行丢失事故：网关把段落分隔 `\n\n` 作为独立纯空白 delta 发送，
	// 旧 processTextContent 整块吞掉（把"不置标志"做成了"不发射"），Markdown 段落
	// 结构塌缩（"## 标题\n\n1." 黏成 "## 标题1."）。修复后空白照常发射、字节级保真。
	test("preserves standalone whitespace deltas (paragraph separators) byte-for-byte", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		const raw = "## 两件等你拍板的事\n\n1. **第一件**——内容\n2. `第二件` 内容";
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "## 两件等你拍板的事" },
				{ type: "response.output_text.delta", delta: "\n\n" },
				{ type: "response.output_text.delta", delta: "1. **第一件**——内容" },
				{ type: "response.output_text.delta", delta: "\n2. `第二件` 内容" },
				{ type: "response.output_text.done", text: raw },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectText(parts), raw);
	});

	// 不变量守护：纯空白 delta 不得置位"已发射真实正文"标志，否则 XML think 门控
	// 被永久关闭、思考被当正文显示（2026-08-22 门控本意）。今日修复把"发射"与
	// "置标志"拆开，此测试防止未来有人把两者再合并回吞空白。
	test("leading whitespace delta does not close the XML think gate", async () => {
		const api = new OpenaiResponsesApi("test-model");
		const { progress, parts } = recordingProgress();
		const token = new vscode.CancellationTokenSource().token;
		await api.processStreamingResponse(
			sseStream([
				{ type: "response.output_text.delta", delta: "  \n" },
				{ type: "response.output_text.delta", delta: "<think>secret</think>" },
				{ type: "response.output_text.delta", delta: "visible body" },
				{ type: "response.completed" },
			]),
			progress,
			token
		);
		assert.strictEqual(collectThinking(parts), "secret");
		assert.strictEqual(collectText(parts).trim(), "visible body");
		assert.ok(!collectText(parts).includes("<think>"), "think tag must not leak into visible text");
	});
});
