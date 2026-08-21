import * as assert from "assert";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createModelConfigurationSchema,
	ensureModelContextDefaults,
	getConfiguredContextSize,
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
} from "../modelConfiguration";
import { OllamaApi } from "../ollama/ollamaApi";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { toModelPickerInfo } from "../provideModel";
import type { HFModelItem } from "../types";

suite("modelConfiguration", () => {
	const deepSeekModel: HFModelItem = {
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		owned_by: "deepseek",
		baseUrl: "https://api.deepseek.com",
		apiMode: "openai",
		context_length: 1_000_000,
		max_tokens: 384_000,
		reasoning_effort: "medium",
	};

	test("only enables the picker when the model has a reasoning effort default", () => {
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "custom" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "high" }), true);
	});

	test("defines reasoning effort choices for provider configuration", () => {
		const reasoningEffort = REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort;
		assert.strictEqual(reasoningEffort.title, "Reasoning Effort");
		assert.strictEqual(reasoningEffort.default, "medium");
		assert.deepStrictEqual(reasoningEffort.enum, ["minimal", "low", "medium", "high", "xhigh", "max"]);
		const modelSchema = createModelConfigurationSchema({ id: "m", owned_by: "p", reasoning_effort: "high" });
		const configuredEffort = modelSchema?.properties.reasoningEffort as { default: string };
		assert.strictEqual(configuredEffort.default, "high");
	});

	test("limits reasoning effort choices to the model's declared supported values", () => {
		const modelSchema = createModelConfigurationSchema({
			id: "qwen3.8-max",
			owned_by: "qwen",
			reasoning_effort: "xhigh",
			reasoning_efforts: ["low", "medium", "xhigh"],
		});
		const reasoningEffort = modelSchema?.properties.reasoningEffort as {
			enum: string[];
			enumItemLabels: string[];
			default: string;
		};

		assert.deepStrictEqual(reasoningEffort.enum, ["low", "medium", "xhigh"]);
		assert.deepStrictEqual(reasoningEffort.enumItemLabels, ["Low", "Medium", "Extra High"]);
		assert.strictEqual(reasoningEffort.default, "xhigh");
		assert.strictEqual(
			getConfiguredReasoningEffort(
				{ modelConfiguration: { reasoningEffort: "max" } } as never,
				"xhigh",
				["low", "medium", "xhigh"]
			),
			"xhigh"
		);
	});

	test("defines context size choices with the configured default", () => {
		const schema = createModelConfigurationSchema({
			id: "deepseek-v4-pro",
			owned_by: "deepseek",
			context_length: 524_288,
			context_sizes: [524_288, 131_072, 262_144],
			default_context_size: 524_288,
			max_tokens: 16_384,
		});
		const contextSize = schema?.properties.contextSize as {
			enum: number[];
			enumItemLabels: string[];
			default: number;
			group: string;
		};

		assert.deepStrictEqual(contextSize.enum, [114_688, 245_760, 507_904]);
		assert.deepStrictEqual(contextSize.enumItemLabels, ["128K", "256K", "512K"]);
		assert.strictEqual(contextSize.default, 507_904);
		assert.strictEqual(contextSize.group, "tokens");
	});

	test("formats million-token context labels as M", () => {
		const schema = createModelConfigurationSchema({
			id: "deepseek-v4-pro",
			owned_by: "deepseek",
			context_length: 1_000_000,
			context_sizes: [262_144, 524_288, 1_000_000],
			default_context_size: 524_288,
			max_tokens: 384_000,
		});
		const contextSize = schema?.properties.contextSize as { enum: number[]; enumItemLabels: string[] };

		assert.deepStrictEqual(contextSize.enumItemLabels, ["256K", "512K", "1M"]);
		assert.deepStrictEqual(contextSize.enum, [1, 140_288, 616_000]);
	});

	test("fills the missing default context size with the largest selectable size", () => {
		const normalized = ensureModelContextDefaults({
			id: "m",
			owned_by: "p",
			context_length: 524_288,
			context_sizes: [131_072, 262_144, 524_288],
		});

		assert.deepStrictEqual(normalized, {
			id: "m",
			owned_by: "p",
			context_length: 524_288,
			context_sizes: [131_072, 262_144, 524_288],
			default_context_size: 524_288,
		});
	});

	test("keeps an explicit default context size that is selectable", () => {
		const model = {
			id: "m",
			owned_by: "p",
			context_sizes: [131_072, 524_288],
			default_context_size: 131_072,
		};

		assert.strictEqual(ensureModelContextDefaults(model), model);
	});

	test("replaces a default context size that is not selectable", () => {
		const normalized = ensureModelContextDefaults({
			id: "m",
			owned_by: "p",
			context_sizes: [131_072, 524_288],
			default_context_size: 262_144,
		});

		assert.strictEqual(normalized.default_context_size, 524_288);
	});

	test("does not invent context defaults when no context sizes are configured", () => {
		const model = { id: "m", owned_by: "p", context_length: 128_000 };

		assert.strictEqual(ensureModelContextDefaults(model), model);
	});

	test("ignores invalid context sizes when computing the default", () => {
		const normalized = ensureModelContextDefaults({
			id: "m",
			owned_by: "p",
			context_length: 524_288,
			context_sizes: [131_072, 999_999_999, 262_144],
		});

		assert.strictEqual(normalized.default_context_size, 262_144);
	});

	test("reads the selected reasoning effort from VS Code model configuration", () => {
		assert.strictEqual(getConfiguredReasoningEffort(undefined), "medium");
		assert.strictEqual(getConfiguredReasoningEffort(undefined, "low"), "low");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "high" } } as never),
			"high"
		);
		assert.strictEqual(getConfiguredReasoningEffort({ configuration: { reasoningEffort: "max" } } as never), "max");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "invalid" } } as never, "xhigh"),
			"xhigh"
		);
	});

	// These two tests used to go through prepareLanguageModelChatInformation with
	// a real (empty) config, which worked before the 2026-08-05 merge-mode change:
	// configured models are now dropped unless the endpoint can be verified, so
	// the test environment (no baseUrl/secrets) only ever got the placeholder.
	// They now assert the picker-info assembly directly — the thing they always
	// meant to check — without touching the verification chain.
	test("registers deepseek-v4-flash with reasoning effort metadata", () => {
		const model: HFModelItem = { ...deepSeekModel, id: "deepseek-v4-flash", displayName: undefined };

		const info = toModelPickerInfo(model) as ModelPickerChatInformation;

		assert.strictEqual(info.id, "deepseek-v4-flash");
		// 用户配置缺失 displayName 时回退到内置模型表名称（package.json 默认值）
		assert.strictEqual(info.name, "DeepSeek Flash");
		assert.strictEqual(info.detail, "deepseek (Libiao Copilot)");
		assert.strictEqual(info.isUserSelectable, true);
		assert.deepStrictEqual(info.configurationSchema, createModelConfigurationSchema(model));
		assert.deepStrictEqual(
			(info.configurationSchema?.properties.reasoningEffort as { default: string }).default,
			"medium"
		);
	});

	test("does not register reasoning effort metadata when the default is empty", () => {
		const model: HFModelItem = {
			...deepSeekModel,
			id: "deepseek-v4-flash",
			displayName: undefined,
			reasoning_effort: undefined,
		};

		const info = toModelPickerInfo(model) as ModelPickerChatInformation;

		assert.strictEqual(info.id, "deepseek-v4-flash");
		assert.strictEqual(info.configurationSchema, undefined);
	});

	test("applies selected reasoning effort to OpenAI-compatible chat requests", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			deepSeekModel,
			{ modelConfiguration: { reasoningEffort: "high" } } as never
		);

		assert.strictEqual(requestBody.reasoning_effort, "high");
	});

	test("rejects a reasoning effort that the model does not support", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			{ ...deepSeekModel, reasoning_effort: "high", reasoning_efforts: ["low", "high", "xhigh", "max"] },
			{ modelConfiguration: { reasoningEffort: "medium" } } as never
		);

		assert.strictEqual(requestBody.reasoning_effort, "high");
	});

	test("falls back to the configured default reasoning effort when Copilot has no temporary override", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			{ ...deepSeekModel, reasoning_effort: "low" },
			undefined
		);

		assert.strictEqual(requestBody.reasoning_effort, "low");
	});

	test("applies selected reasoning effort to OpenAI Responses requests", () => {
		const requestBody = new OpenaiResponsesApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", input: [], stream: true },
			{ ...deepSeekModel, apiMode: "openai-responses" },
			{ modelConfiguration: { reasoningEffort: "max" } } as never
		);

		assert.deepStrictEqual(requestBody.reasoning, { effort: "max" });
	});

	test("keeps the picker out of unsupported native API request bodies", () => {
		const options = { modelConfiguration: { reasoningEffort: "high" } } as never;
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic" },
			options
		) as unknown as Record<string, unknown>;
		const ollamaBody = new OllamaApi("qwen3").prepareRequestBody(
			{ model: "qwen3", messages: [], stream: true },
			{ ...deepSeekModel, apiMode: "ollama" },
			options
		) as unknown as Record<string, unknown>;
		const geminiBody = new GeminiApi("gemini").prepareRequestBody(
			{ contents: [] },
			{ ...deepSeekModel, apiMode: "gemini" },
			options
		) as Record<string, unknown>;

		assert.strictEqual(anthropicBody.reasoning_effort, undefined);
		assert.strictEqual(anthropicBody.thinking, undefined);
		assert.strictEqual(ollamaBody.reasoning_effort, undefined);
		assert.strictEqual(ollamaBody.think, undefined);
		assert.strictEqual(geminiBody.reasoning_effort, undefined);
		assert.strictEqual(geminiBody.thinkingConfig, undefined);
	});

	test("reads the context size selected in the Configure menu", () => {
		// The Configure picker's contextSize value never triggers truncation in
		// VS Code; we read it as an input-side budget for context management.
		assert.strictEqual(
			getConfiguredContextSize({ modelConfiguration: { contextSize: 256000 } } as never),
			256000
		);
		assert.strictEqual(
			getConfiguredContextSize({ configuration: { contextSize: 128000 } } as never),
			128000
		);
		assert.strictEqual(getConfiguredContextSize({} as never), undefined);
		assert.strictEqual(getConfiguredContextSize({ modelConfiguration: { contextSize: 0 } } as never), undefined);
		assert.strictEqual(
			getConfiguredContextSize({ modelConfiguration: { contextSize: -1 } } as never),
			undefined
		);
		assert.strictEqual(
			getConfiguredContextSize({ modelConfiguration: { contextSize: "not-a-number" } } as never),
			undefined
		);
	});
});
