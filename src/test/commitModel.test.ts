import * as assert from "assert";
import type { HFModelItem } from "../types";
import {
	DEFAULT_COMMIT_MODEL,
	RECOMMENDED_COMMIT_MODEL_IDS,
	getRecommendedCommitModels,
	resolveValidCommitModel,
} from "../utils";
import { isVersionOlder, runVersionMigrations } from "../versionManager";

suite("commitModel recommendations & auto-healing", () => {
	const qwenFlashModel: HFModelItem = {
		id: "qwen3.8-flash",
		displayName: "Qwen 3.8 Flash",
		owned_by: "libiaorobot",
		apiMode: "openai-responses",
	};

	const glmFlashModel: HFModelItem = {
		id: "glm-5.3-flash",
		displayName: "GLM 5.3 Flash",
		owned_by: "libiaorobot",
		apiMode: "openai-responses",
	};

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

	test("default commit model is qwen3.8-flash", () => {
		assert.strictEqual(DEFAULT_COMMIT_MODEL, "qwen3.8-flash");
		assert.deepStrictEqual(RECOMMENDED_COMMIT_MODEL_IDS, [
			"qwen3.8-flash",
			"glm-5.3-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v4-flash",
		]);
	});

	test("filters and preserves recommended order from builtInModels and userModels", () => {
		const builtInMap = new Map<string, HFModelItem>([
			["deepseek-v4-flash", flashModel],
			["glm-5.3-flash", glmFlashModel],
			["qwen3.8-max", qwenMaxModel],
		]);

		const userModels: HFModelItem[] = [qwenFlashModel];
		const result = getRecommendedCommitModels(userModels, builtInMap);

		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0].id, "qwen3.8-flash");
		assert.strictEqual(result[1].id, "glm-5.3-flash");
		assert.strictEqual(result[2].id, "deepseek-v4-flash");
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
		const available = [qwenFlashModel, flashModel];
		const resolved = resolveValidCommitModel("deepseek-v4-flash", available);
		assert.strictEqual(resolved, "deepseek-v4-flash");
	});

	test("resolveValidCommitModel heals legacy/unsupported model back to first available or default", () => {
		const available = [qwenFlashModel, flashModel];
		// 用户历史配置了 qwen3.8-max 或 r1
		const resolved = resolveValidCommitModel("qwen3.8-max", available);
		assert.strictEqual(resolved, "qwen3.8-flash");

		const resolvedFromEmpty = resolveValidCommitModel(undefined, available);
		assert.strictEqual(resolvedFromEmpty, "qwen3.8-flash");

		const resolvedWithNoAvailable = resolveValidCommitModel("invalid", []);
		assert.strictEqual(resolvedWithNoAvailable, "qwen3.8-flash");
	});

	test("isVersionOlder correctly evaluates semver versions", () => {
		assert.strictEqual(isVersionOlder("1.2.3", "1.2.4"), true);
		assert.strictEqual(isVersionOlder("1.1.9", "1.2.0"), true);
		assert.strictEqual(isVersionOlder("1.2.4", "1.2.4"), false);
		assert.strictEqual(isVersionOlder("1.3.0", "1.2.4"), false);
		assert.strictEqual(isVersionOlder("1.2.10", "1.2.4"), false);
	});

	test("runVersionMigrations performs one-time migration and records lastVersion in globalState", async () => {
		const store = new Map<string, unknown>();
		store.set("libiaoCopilot.lastVersion", "1.2.3");

		const mockContext = {
			globalState: {
				get: <T>(key: string) => store.get(key) as T | undefined,
				update: async (key: string, value: unknown) => {
					store.set(key, value);
				},
			},
		} as unknown as import("vscode").ExtensionContext;

		await runVersionMigrations(mockContext);

		assert.strictEqual(store.get("libiaoCopilot.lastVersion"), "1.2.4");
	});
});
