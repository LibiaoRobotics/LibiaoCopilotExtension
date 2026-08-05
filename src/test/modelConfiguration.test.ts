import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createModelConfigurationSchema,
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
} from "../modelConfiguration";
import { OllamaApi } from "../ollama/ollamaApi";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { prepareLanguageModelChatInformation } from "../provideModel";
import type { HFModelItem } from "../types";

suite("modelConfiguration", () => {
	// Stub secret storage with no keys: merge mode falls back to the
	// configured entries per endpoint group without hitting the network.
	const emptySecrets = {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
	} satisfies vscode.SecretStorage;

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

	test("registers deepseek-v4-flash with reasoning effort metadata", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("libiaoCopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = { ...deepSeekModel, id: "deepseek-v4-flash", displayName: undefined };

		try {
			await config.update("libiaoCopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, emptySecrets);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.name, "deepseek-v4-flash");
			assert.strictEqual(info.detail, "deepseek (Libiao Copilot)");
			assert.strictEqual(info.isUserSelectable, true);
			assert.deepStrictEqual(info.configurationSchema, createModelConfigurationSchema(model));
		} finally {
			cts.dispose();
			await config.update("libiaoCopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("does not register reasoning effort metadata when the default is empty", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("libiaoCopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			...deepSeekModel,
			id: "deepseek-v4-flash",
			displayName: undefined,
			reasoning_effort: undefined,
		};

		try {
			await config.update("libiaoCopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, emptySecrets);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.configurationSchema, undefined);
		} finally {
			cts.dispose();
			await config.update("libiaoCopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
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
});
