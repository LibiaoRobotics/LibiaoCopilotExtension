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
});
