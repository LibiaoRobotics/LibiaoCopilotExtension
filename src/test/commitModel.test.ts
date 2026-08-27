import * as assert from "assert";
import type { HFModelItem } from "../types";
import {
	DEFAULT_COMMIT_MODEL,
	RECOMMENDED_COMMIT_MODEL_IDS,
	getRecommendedCommitModels,
	resolveValidCommitModel,
} from "../utils";

suite("commitModel recommendations & auto-healing", () => {
	const flashModel: HFModelItem = {
		id: "deepseek-v4-flash",
		displayName: "DeepSeek Flash",
		owned_by: "libiaorobot",
		apiMode: "openai-responses",
	};

	const qwenMaxModel: HFModelItem = {
		id: "qwen3.8-max",
		displayName: "Qwen 3.8 Max",
		owned_by: "libiaorobot",
		apiMode: "openai-responses",
	};

	const customFlashModel: HFModelItem = {
		id: "deepseek-v4-flash",
		displayName: "My Custom Flash",
		configId: "fast",
		owned_by: "custom",
		apiMode: "openai",
	};

	test("default commit model is deepseek-v4-flash", () => {
		assert.strictEqual(DEFAULT_COMMIT_MODEL, "deepseek-v4-flash");
		assert.ok(RECOMMENDED_COMMIT_MODEL_IDS.includes("deepseek-v4-flash"));
	});

	test("filters and preserves recommended order from builtInModels and userModels", () => {
		const builtInMap = new Map<string, HFModelItem>([
			["deepseek-v4-flash", flashModel],
			["qwen3.8-max", qwenMaxModel],
		]);

		const userModels: HFModelItem[] = [qwenMaxModel];
		const result = getRecommendedCommitModels(userModels, builtInMap);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, "deepseek-v4-flash");
	});

	test("prefers user configured model over built-in if matched", () => {
		const builtInMap = new Map<string, HFModelItem>([
			["deepseek-v4-flash", flashModel],
		]);

		const userModels: HFModelItem[] = [customFlashModel];
		const result = getRecommendedCommitModels(userModels, builtInMap);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].displayName, "My Custom Flash");
	});

	test("resolveValidCommitModel keeps valid recommended model", () => {
		const available = [flashModel];
		const resolved = resolveValidCommitModel("deepseek-v4-flash", available);
		assert.strictEqual(resolved, "deepseek-v4-flash");
	});

	test("resolveValidCommitModel heals legacy/unsupported model back to default", () => {
		const available = [flashModel];
		// 用户历史配置了 qwen3.8-max 或 r1
		const resolved = resolveValidCommitModel("qwen3.8-max", available);
		assert.strictEqual(resolved, "deepseek-v4-flash");

		const resolvedFromEmpty = resolveValidCommitModel(undefined, available);
		assert.strictEqual(resolvedFromEmpty, "deepseek-v4-flash");
	});
});
