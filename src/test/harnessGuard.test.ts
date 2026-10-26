import * as assert from "assert";
import { HARNESS_DEFAULT_FLAGS, HarnessConfigApi, suppressHarnessDefault } from "../harnessGuard";

interface UpdateCall {
	section: string;
	key: string;
	value: boolean;
}

/** 记录写调用的假配置；`values` 用 "section.key" 作键。 */
class MockConfigApi implements HarnessConfigApi {
	readonly updates: UpdateCall[] = [];
	readonly values = new Map<string, boolean | undefined>();
	failOn: string | undefined;

	get(section: string, key: string): boolean | undefined {
		return this.values.get(`${section}.${key}`);
	}

	async update(section: string, key: string, value: boolean): Promise<void> {
		const fullKey = `${section}.${key}`;
		if (this.failOn === fullKey) {
			throw new Error("write rejected");
		}
		this.updates.push({ section, key, value });
		this.values.set(fullKey, value);
	}
}

suite("Harness Guard Tests", () => {
	test("HARNESS_DEFAULT_FLAGS: 覆盖两个会把默认会话推向 agent host 的配置项", () => {
		const keys = HARNESS_DEFAULT_FLAGS.map((flag) => flag.fullKey);
		assert.deepStrictEqual(keys, ["chat.defaultToCopilotHarness", "chat.editor.preferCopilotHarness"]);
	});

	test("suppressHarnessDefault: 两个开关都被实验推成 true 时全部改写为 false", async () => {
		const api = new MockConfigApi();
		api.values.set("chat.defaultToCopilotHarness", true);
		api.values.set("chat.editor.preferCopilotHarness", true);

		const corrected = await suppressHarnessDefault(api);

		assert.deepStrictEqual(corrected, ["chat.defaultToCopilotHarness", "chat.editor.preferCopilotHarness"]);
		assert.deepStrictEqual(api.updates, [
			{ section: "chat", key: "defaultToCopilotHarness", value: false },
			{ section: "chat.editor", key: "preferCopilotHarness", value: false },
		]);
	});

	test("suppressHarnessDefault: 仅一个开关为 true 时只改这一个", async () => {
		const api = new MockConfigApi();
		api.values.set("chat.defaultToCopilotHarness", false);
		api.values.set("chat.editor.preferCopilotHarness", true);

		const corrected = await suppressHarnessDefault(api);

		assert.deepStrictEqual(corrected, ["chat.editor.preferCopilotHarness"]);
		assert.strictEqual(api.updates.length, 1);
	});

	test("suppressHarnessDefault: 有效值为 false 或未设置时不写任何配置", async () => {
		const api = new MockConfigApi();
		api.values.set("chat.defaultToCopilotHarness", false);
		// chat.editor.preferCopilotHarness 保持未设置

		const corrected = await suppressHarnessDefault(api);

		assert.deepStrictEqual(corrected, []);
		assert.strictEqual(api.updates.length, 0, "有效值不是 true 时不应产生写操作");
	});

	test("suppressHarnessDefault: 单个配置写入失败时其余配置仍被修正且不抛出", async () => {
		const api = new MockConfigApi();
		api.values.set("chat.defaultToCopilotHarness", true);
		api.values.set("chat.editor.preferCopilotHarness", true);
		api.failOn = "chat.defaultToCopilotHarness";

		const corrected = await suppressHarnessDefault(api);

		assert.deepStrictEqual(corrected, ["chat.editor.preferCopilotHarness"]);
	});

	test("suppressHarnessDefault: 幂等，第二次执行不再产生写操作", async () => {
		const api = new MockConfigApi();
		api.values.set("chat.defaultToCopilotHarness", true);
		api.values.set("chat.editor.preferCopilotHarness", true);

		await suppressHarnessDefault(api);
		const secondRun = await suppressHarnessDefault(api);

		assert.deepStrictEqual(secondRun, []);
		assert.strictEqual(api.updates.length, 2, "总写入次数应仍为第一次的两条");
	});
});
