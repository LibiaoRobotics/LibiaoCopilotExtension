import * as assert from "assert";
import { createModelConfigurationSchema } from "../modelConfiguration";
import { toDiscoveredModelItem, toModelPickerInfo } from "../provideModel";
import type { HFModelItem } from "../types";

/**
 * 覆盖 fallback path（models 为空时 API 直连）的核心组装逻辑：
 * - toDiscoveredModelItem：API 裸模型 + 内置表元数据合并（上下文/思考深度/vision）
 * - toModelPickerInfo：合并后的模型生成 configurationSchema（上下文大小/思考深度选择器）
 *
 * 注：prepareLanguageModelChatInformation 本身依赖 vscode 配置/secrets/真实网络，
 * 无法在单测中直接调用；这里直接测它内部使用的两个纯函数。
 */
suite("provideModel", () => {
	suite("toDiscoveredModelItem", () => {
		test("uses built-in metadata as the authoritative source when the model is known", () => {
			// API 网关只返回裸 id（无 context_length/reasoning_effort），
			// 内置表声明 1M 上下文 + max 思考深度 → 合并结果以内置为准
			const apiModel: HFModelItem = {
				id: "deepseek-v4-flash",
				owned_by: "libiaorobot",
			};

			const merged = toDiscoveredModelItem(apiModel);

			assert.strictEqual(merged.id, "deepseek-v4-flash");
			assert.strictEqual(merged.context_length, 1_000_000);
			assert.strictEqual(merged.reasoning_effort, "max");
			assert.deepStrictEqual(merged.reasoning_efforts, ["low", "high", "xhigh", "max"]);
			assert.strictEqual(merged.max_tokens, 384_000);
		});

		test("keeps live-only fields from the API listing when the model is known", () => {
			// 内置表没有的字段（如 architecture/providers）不能被内置合并覆盖掉
			const apiModel: HFModelItem = {
				id: "deepseek-v4-flash",
				owned_by: "libiaorobot",
				architecture: { input_modalities: ["text", "image"] },
				providers: [{ provider: "gateway", status: "ok", context_length: 128_000 }],
			};

			const merged = toDiscoveredModelItem(apiModel);

			assert.deepStrictEqual(merged.architecture, { input_modalities: ["text", "image"] });
			assert.strictEqual(merged.providers?.[0]?.provider, "gateway");
		});

		test("falls back to the API provider context length when the model is unknown", () => {
			// 内置表没有该模型 → context_length 从 providers[0] 兜底
			const apiModel: HFModelItem = {
				id: "unknown-brand-new-model",
				owned_by: "gateway",
				providers: [{ provider: "gateway", status: "ok", context_length: 524_288 }],
			};

			const merged = toDiscoveredModelItem(apiModel);

			assert.strictEqual(merged.context_length, 524_288);
			assert.strictEqual(merged.reasoning_effort, undefined);
		});

		test("prefers explicit vision flag over built-in and modality inference", () => {
			// m.vision 显式声明优先（true 覆盖内置 false，false 覆盖内置 true）
			const explicitTrue: HFModelItem = { id: "deepseek-v4-flash", owned_by: "libiaorobot", vision: true };
			const explicitFalse: HFModelItem = {
				id: "deepseek-v4-flash-vision-exp",
				owned_by: "libiaorobot",
				vision: false,
			};

			assert.strictEqual(toDiscoveredModelItem(explicitTrue).vision, true);
			assert.strictEqual(toDiscoveredModelItem(explicitFalse).vision, false);
		});

		test("infers vision from architecture modalities when no explicit flag", () => {
			const apiModel: HFModelItem = {
				id: "unknown-vision-model",
				owned_by: "gateway",
				architecture: { input_modalities: ["text", "image"] },
			};

			assert.strictEqual(toDiscoveredModelItem(apiModel).vision, true);
		});

		test("uses built-in vision when API has no modality info", () => {
			// 内置表声明 vision: true，API 未返回任何模态信息 → 内置兜底
			const apiModel: HFModelItem = {
				id: "deepseek-v4-flash-vision-exp",
				owned_by: "libiaorobot",
			};

			assert.strictEqual(toDiscoveredModelItem(apiModel).vision, true);
		});
	});

	suite("toModelPickerInfo vision-driven display name", () => {
		// emoji 用码点转义（👁️ = U+1F441 + U+FE0F，🖼️ = U+1F5BC + U+FE0F），避免字面 emoji 编码问题
		const VISION_EMOJI = "\u{1F441}\uFE0F";
		const VISION_EMOJI_PICTURE = "\u{1F5BC}\uFE0F";

		test("adds vision picture emoji prefix by default when vision is true", () => {
			const model: HFModelItem = { id: "qwen3.8-max", owned_by: "libiaorobot", vision: true, displayName: "Qwen 3.8 Max" };
			const info = toModelPickerInfo(model);
			assert.strictEqual(info.name, `${VISION_EMOJI_PICTURE}Qwen 3.8 Max`);
		});

		test("adds vision eye emoji prefix when icon is eye", () => {
			const model: HFModelItem = { id: "qwen3.8-max", owned_by: "libiaorobot", vision: true, displayName: "Qwen 3.8 Max" };
			const info = toModelPickerInfo(model, "eye");
			assert.strictEqual(info.name, `${VISION_EMOJI}Qwen 3.8 Max`);
		});

		test("strips legacy eye prefix when switching to picture icon", () => {
			// 存量配置 displayName 可能带旧版 👁️ 前缀，默认 picture 下不得出现双前缀
			const model: HFModelItem = {
				id: "qwen3.8-max",
				owned_by: "libiaorobot",
				vision: true,
				displayName: `${VISION_EMOJI}Qwen 3.8 Max`,
			};
			const info = toModelPickerInfo(model);
			assert.strictEqual(info.name, `${VISION_EMOJI_PICTURE}Qwen 3.8 Max`);
		});

		test("does not add emoji when vision is false or undefined", () => {
			const model: HFModelItem = { id: "deepseek-v4-flash", owned_by: "libiaorobot", vision: false, displayName: "DeepSeek Flash" };
			const info = toModelPickerInfo(model);
			assert.strictEqual(info.name, "DeepSeek Flash");
		});

		test("does not duplicate the emoji prefix for legacy configured names", () => {
			// 存量用户配置的 displayName 可能已含 emoji（旧版手工维护）→ 不得重复添加
			const model: HFModelItem = {
				id: "qwen3.8-max",
				owned_by: "libiaorobot",
				vision: true,
				displayName: `${VISION_EMOJI_PICTURE}Qwen 3.8 Max`,
			};
			const info = toModelPickerInfo(model);
			assert.strictEqual(info.name, `${VISION_EMOJI_PICTURE}Qwen 3.8 Max`);
		});

		test("falls back to built-in vision when the model declares none", () => {
			// 用户配置未写 vision，但内置表声明 vision: true（deepseek-v4-flash-vision-exp）
			const model: HFModelItem = { id: "deepseek-v4-flash-vision-exp", owned_by: "libiaorobot" };
			const info = toModelPickerInfo(model);
			assert.strictEqual(info.name, `${VISION_EMOJI_PICTURE}Deepseek Flash 识图版`);
			assert.strictEqual(info.capabilities.imageInput, true);
		});
	});

	suite("toModelPickerInfo fallback schema", () => {
		test("generates configurationSchema with both context size and reasoning effort after merge", () => {
			// 模拟 fallback path：API 裸模型 → toDiscoveredModelItem 合并内置元数据
			// → toModelPickerInfo → configurationSchema 必须同时含 contextSize + reasoningEffort
			const apiModel: HFModelItem = { id: "deepseek-v4-flash", owned_by: "libiaorobot" };
			const merged = toDiscoveredModelItem(apiModel);
			const info = toModelPickerInfo(merged);

			assert.ok(info.configurationSchema, "merged fallback model must have configurationSchema");
			assert.ok(info.configurationSchema?.properties.reasoningEffort, "must expose reasoning effort picker");
			assert.ok(info.configurationSchema?.properties.contextSize, "must expose context size picker");
		});

		test("keeps schema undefined when no metadata is available anywhere", () => {
			// 内置表无此模型、API 也无元数据 → 不生成 schema，且不崩溃
			const apiModel: HFModelItem = { id: "totally-unknown-model", owned_by: "gateway" };
			const merged = toDiscoveredModelItem(apiModel);
			const info = toModelPickerInfo(merged);

			assert.strictEqual(info.configurationSchema, undefined);
		});

		test("generates schema identical to createModelConfigurationSchema on merged model", () => {
			const apiModel: HFModelItem = { id: "deepseek-v4-flash", owned_by: "libiaorobot" };
			const merged = toDiscoveredModelItem(apiModel);

			assert.deepStrictEqual(
				toModelPickerInfo(merged).configurationSchema,
				createModelConfigurationSchema(merged)
			);
		});

		test("exposes maxInputTokens consistent with built-in context length", () => {
			// 内置 1M 上下文、384K 输出 → maxInputTokens = 1M - 384K
			const apiModel: HFModelItem = { id: "deepseek-v4-flash", owned_by: "libiaorobot" };
			const merged = toDiscoveredModelItem(apiModel);
			const info = toModelPickerInfo(merged);

			assert.strictEqual(info.maxInputTokens, 1_000_000 - 384_000);
			assert.strictEqual(info.maxOutputTokens, 384_000);
		});
	});

	suite("getValidContextSizes boundaries", () => {
		test("filters context sizes exceeding the context length", () => {
			// 内置表声明 context_length 1M，但 context_sizes 含 2M（超范围）→ 被过滤
			const model: HFModelItem = {
				id: "boundary-model",
				owned_by: "p",
				context_length: 1_000_000,
				context_sizes: [262_144, 524_288, 1_000_000, 2_000_000],
			};

			const schema = createModelConfigurationSchema(model);

			// 模型无 max_tokens → maxOutputTokens 为 0，inputSizes = contextSizes
			assert.deepStrictEqual(
				(schema?.properties.contextSize as { enum: number[] }).enum,
				[262_144, 524_288, 1_000_000]
			);
		});

		test("deduplicates repeated context sizes", () => {
			const model: HFModelItem = {
				id: "dup-model",
				owned_by: "p",
				context_length: 1_000_000,
				context_sizes: [262_144, 262_144, 524_288, 524_288],
			};

			const schema = createModelConfigurationSchema(model);

			assert.deepStrictEqual(
				(schema?.properties.contextSize as { enum: number[] }).enum,
				[262_144, 524_288]
			);
		});
	});
});
