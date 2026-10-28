import * as vscode from "vscode";
import { LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { tokenizerManager } from "./tokenizer/tokenizerManager";
import { getImageDimensions } from "./tokenizer/imageUtils";
import { createDataUrl } from "./utils";

/*
 * Each message comes with 3 tokens per message due to special characters
 */
export const BaseTokensPerMessage = 3;
/*
 * Each name costs 1 token
 */
export const BaseTokensPerName = 1;

/**
 * 图片尺寸解析失败时的兜底值：按 800×600 截图（4 个 512 像素块）估算。
 * 既不能返回 0（会把截图误判成免费），也不能退化成对整段 base64 做 BPE（会放大上千倍）。
 */
const FallbackImageTokens = 765;

export async function countMessageTokens(
	text: string | LanguageModelChatRequestMessage,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
	if (typeof text === "string") {
		return textTokenLength(text);
	}

	// For complex messages, calculate tokens for each part separately
	let totalTokens = BaseTokensPerMessage + BaseTokensPerName;
	for (const part of text.content) {
		totalTokens += await countPartTokens(part, modelConfig);
	}
	return totalTokens;
}

/**
 * 单个内容分片的 token 数。
 *
 * 工具结果必须递归下钻而不是整体 JSON.stringify：其 content 里可能内嵌截图，
 * Uint8Array 会被序列化成 { "0":137, "1":80, ... } 的数字表——一张 400KB 截图
 * 就能从 ~1100 token 放大到上百万，进而让上下文预算误判超限、触发无谓的摘要与裁剪。
 */
async function countPartTokens(
	part: unknown,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
	if (typeof part === "string") {
		return textTokenLength(part);
	}
	if (part instanceof vscode.LanguageModelTextPart) {
		return textTokenLength(part.value);
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		return countDataPartTokens(part);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return BaseTokensPerName + (await textTokenLength(JSON.stringify(part.input)));
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		const content = (part as { content?: readonly unknown[] }).content ?? [];
		let totalTokens = 0;
		for (const child of content) {
			totalTokens += await countPartTokens(child, modelConfig);
		}
		return totalTokens;
	}
	if (part instanceof vscode.LanguageModelThinkingPart) {
		if (!modelConfig.includeReasoningInRequest) {
			return 0;
		}
		const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
		return textTokenLength(thinkingText);
	}
	console.warn("Unknown part type in token count");
	return 0;
}

function countDataPartTokens(part: vscode.LanguageModelDataPart): number {
	if (part.mimeType === "cache_control") {
		return 0;
	}
	if (part.mimeType.startsWith("image/")) {
		return countImageTokens(part);
	}
	// For other binary data, use a more conservative estimate
	return calculateNonImageBinaryTokens(part.data.byteLength);
}

function countImageTokens(part: vscode.LanguageModelDataPart): number {
	try {
		const tokens = calculateImageTokenCost(createDataUrl(part));
		return tokens > 0 ? tokens : FallbackImageTokens;
	} catch {
		// 不支持的格式或损坏的图片数据：按单块视觉预算兜底，绝不让异常冒泡到计费方
		return FallbackImageTokens;
	}
}

export async function textTokenLength(text: string): Promise<number> {
	try {
		return tokenizerManager.countTokens(text);
	} catch {
		return 0;
	}
}

export async function countToolTokens(tools: readonly LanguageModelChatTool[]): Promise<number> {
	const baseToolTokens = 16;
	let numTokens = 0;
	if (tools.length) {
		numTokens += baseToolTokens;
	}

	const baseTokensPerTool = 8;
	for (const tool of tools) {
		numTokens += baseTokensPerTool;
		numTokens += await textTokenLength(JSON.stringify(tool));
	}

	return numTokens;
}

// https://platform.openai.com/docs/guides/vision#calculating-costs
function calculateImageTokenCost(imageUrl: string): number {
	let { width, height } = getImageDimensions(imageUrl);

	if (width <= 0 || height <= 0) {
		return 0;
	}

	// Scale image to fit within a 2048 x 2048 square if necessary.
	if (width > 2048 || height > 2048) {
		const scaleFactor = 2048 / Math.max(width, height);
		width = Math.round(width * scaleFactor);
		height = Math.round(height * scaleFactor);
	}

	const scaleFactor = 768 / Math.min(width, height);
	width = Math.round(width * scaleFactor);
	height = Math.round(height * scaleFactor);

	const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);

	return tiles * 170 + 85;
}

function calculateNonImageBinaryTokens(byteLength: number): number {
	if (!byteLength) {
		return 0;
	}
	const base = 20;
	const per16Kb = Math.ceil(byteLength / 16384);
	return Math.min(200, base + per16Kb);
}
