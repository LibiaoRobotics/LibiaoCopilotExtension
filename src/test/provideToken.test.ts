import * as assert from "assert";
import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import { BaseTokensPerMessage, BaseTokensPerName, countMessageTokens } from "../provideToken";

/**
 * 上下文 token 计数的回归测试。
 *
 * 核心红线：工具结果里内嵌的二进制分片（截图）必须按图片/二进制规则计数，
 * 绝不能被 JSON.stringify 展开成字节数字表——一张普通截图就能把计数放大上千倍，
 * 导致上下文预算误判超限，进而触发无谓的历史摘要与裁剪。
 */
suite("provideToken", () => {
	const modelConfig = { includeReasoningInRequest: false };
	const messageOverhead = BaseTokensPerMessage + BaseTokensPerName;

	/** 构造带真实 PNG 文件头（签名 + IHDR 尺寸）的数据，填充到指定字节数。 */
	function makePng(width: number, height: number, totalBytes: number): Uint8Array {
		const buf = Buffer.alloc(Math.max(totalBytes, 64));
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
		buf.writeUInt32BE(13, 8);
		buf.write("IHDR", 12, "ascii");
		buf.writeUInt32BE(width, 16);
		buf.writeUInt32BE(height, 20);
		return new Uint8Array(buf);
	}

	const message = (content: unknown[]): LanguageModelChatRequestMessage => ({
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content,
	}) as LanguageModelChatRequestMessage;

	test("工具结果内的截图与同图片作为顶层分片计数一致", async () => {
		// 1920×1080 是常见的整屏截图尺寸
		const png = makePng(1920, 1080, 400 * 1024);

		const topLevel = await countMessageTokens(
			message([new vscode.LanguageModelDataPart(png, "image/png")]),
			modelConfig
		);
		const inToolResult = await countMessageTokens(
			message([
				new vscode.LanguageModelToolResultPart("call-1", [
					new vscode.LanguageModelDataPart(png, "image/png"),
				]),
			]),
			modelConfig
		);

		assert.strictEqual(
			inToolResult,
			topLevel,
			`工具结果内的图片必须按图片规则计数，实际 ${inToolResult} vs 顶层 ${topLevel}`
		);
	});

	test("400KB 截图在工具结果内不会被展开成字节数字表", async () => {
		const png = makePng(1920, 1080, 400 * 1024);
		const tokens = await countMessageTokens(
			message([
				new vscode.LanguageModelToolResultPart("call-1", [
					new vscode.LanguageModelTextPart("Captured screenshot of panel"),
					new vscode.LanguageModelDataPart(png, "image/png"),
				]),
			]),
			modelConfig
		);

		// 修复前该值约 1,255,000（JSON.stringify 展开 Uint8Array 后按文本分词）；
		// 图片本身按 6 个视觉块计费上限 1105，文本部分再小也不过数百
		assert.ok(tokens < 5_000, `截图计数必须落在视觉预算量级，实际 ${tokens}`);
		assert.ok(tokens > 1_000, `截图不能被当成免费内容，实际 ${tokens}`);
	});

	test("工具结果内的非图片二进制分片按保守估算而非字节展开", async () => {
		const blob = new Uint8Array(200 * 1024);
		const tokens = await countMessageTokens(
			message([
				new vscode.LanguageModelToolResultPart("call-1", [
					new vscode.LanguageModelDataPart(blob, "application/octet-stream"),
				]),
			]),
			modelConfig
		);

		assert.ok(tokens < 300, `二进制分片应走保守估算，实际 ${tokens}`);
		assert.ok(tokens >= messageOverhead, "至少包含消息固定开销");
	});

	test("尺寸无法解析的图片不抛异常，按视觉兜底值计数", async () => {
		// 声明为图片但数据不是任何受支持格式（getImageDimensions 会抛错）
		const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const tokens = await countMessageTokens(
			message([new vscode.LanguageModelDataPart(garbage, "image/tiff")]),
			modelConfig
		);

		assert.ok(tokens > 0, "无法解析的图片不能被计为 0");
		assert.ok(tokens <= 1_200, `兜底值必须仍在视觉预算量级，实际 ${tokens}`);
	});

	test("工具结果内的 cache_control 传输标记不计入", async () => {
		const marker = new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({ type: "ephemeral" })),
			"cache_control"
		);
		const withMarker = await countMessageTokens(
			message([new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok"), marker])]),
			modelConfig
		);
		const withoutMarker = await countMessageTokens(
			message([new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")])]),
			modelConfig
		);

		assert.strictEqual(withMarker, withoutMarker);
	});
});
