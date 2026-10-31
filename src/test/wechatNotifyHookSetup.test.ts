import * as assert from "assert";
import {
	hasWechatNotifyStopHook,
	mergeWechatNotifyHookJson,
	WECHAT_INTERACT_HOOK_COMMAND,
	WECHAT_NOTIFY_HOOK_COMMAND,
	type WechatNotifyHookMergeResult,
} from "../wechatNotifyHookSetup";

/** invalid 在调用处已经单独断言过，这里只负责取出文本 */
function textOf(merged: WechatNotifyHookMergeResult): string {
	if (merged.kind === "invalid") {
		assert.fail(`不应是 invalid：${merged.error}`);
	}
	return merged.text;
}

/**
 * 这组断言守的是「hook 注册文件是否真的把三类 hook 都挂上」：
 * - Stop 负责把本轮结果推回群
 * - PreToolUse 负责「在等你选择」的提醒，PostToolUse 负责「已经答完了」的收场信号
 * - 升级场景里老工作区的 json 只有 Stop（甚至只有 Stop + PreToolUse），必须能补齐而不是判成 unchanged
 * - 读不懂的内容一律保持原样，绝不用新内容覆盖用户的配置
 */
suite("企微联动 hook 的注册声明", () => {
	test("新建时同时写入 Stop 与 PreToolUse、PostToolUse", () => {
		const merged = mergeWechatNotifyHookJson(undefined);
		assert.strictEqual(merged.kind, "updated");
		const parsed = JSON.parse(textOf(merged));
		assert.deepStrictEqual(Object.keys(parsed.hooks).sort(), ["PostToolUse", "PreToolUse", "Stop"]);
		assert.strictEqual(parsed.hooks.Stop[0].command, WECHAT_NOTIFY_HOOK_COMMAND);
		assert.strictEqual(parsed.hooks.PreToolUse[0].command, WECHAT_INTERACT_HOOK_COMMAND);
		assert.strictEqual(parsed.hooks.PostToolUse[0].command, WECHAT_INTERACT_HOOK_COMMAND);
		// 工具级的 hook 每个调用都跑，超时必须比 Stop 更短，否则卡住工具延迟
		assert.ok(parsed.hooks.PreToolUse[0].timeout < parsed.hooks.Stop[0].timeout);
		assert.ok(parsed.hooks.PostToolUse[0].timeout < parsed.hooks.Stop[0].timeout);
	});

	test("只有 Stop 的老配置会被补上工具级 hook，且原有条目不变", () => {
		const legacy = `${JSON.stringify(
			{
				hooks: {
					Stop: [{ type: "command", command: WECHAT_NOTIFY_HOOK_COMMAND, timeout: 15 }],
				},
			},
			undefined,
			2
		)}\n`;
		const merged = mergeWechatNotifyHookJson(legacy);
		assert.strictEqual(merged.kind, "updated");
		const parsed = JSON.parse(textOf(merged));
		assert.strictEqual(parsed.hooks.Stop.length, 1);
		assert.strictEqual(parsed.hooks.PreToolUse.length, 1);
		assert.strictEqual(parsed.hooks.PostToolUse.length, 1);
	});

	test("只有 Stop + PreToolUse 的旧版配置要补上 PostToolUse", () => {
		const previous = `${JSON.stringify(
			{
				hooks: {
					Stop: [{ type: "command", command: WECHAT_NOTIFY_HOOK_COMMAND, timeout: 15 }],
					PreToolUse: [{ type: "command", command: WECHAT_INTERACT_HOOK_COMMAND, timeout: 20 }],
				},
			},
			undefined,
			2
		)}\n`;
		const merged = mergeWechatNotifyHookJson(previous);
		// 上版本只挂了两类，缺 PostToolUse 就必须补，否则手机永远收不到收场信号
		assert.strictEqual(merged.kind, "updated");
		const parsed = JSON.parse(textOf(merged));
		assert.strictEqual(parsed.hooks.PreToolUse.length, 1);
		assert.strictEqual(parsed.hooks.PostToolUse.length, 1);
	});

	test("三类都在时原样返回，不重写用户的 json", () => {
		const existing = `${JSON.stringify(
			{
				hooks: {
					Stop: [{ type: "command", command: WECHAT_NOTIFY_HOOK_COMMAND, timeout: 15 }],
					PreToolUse: [{ type: "command", command: WECHAT_INTERACT_HOOK_COMMAND, timeout: 20 }],
					PostToolUse: [{ type: "command", command: WECHAT_INTERACT_HOOK_COMMAND, timeout: 20 }],
				},
				custom: { keep: true },
			},
			undefined,
			4
		)}\n`;
		const merged = mergeWechatNotifyHookJson(existing);
		assert.strictEqual(merged.kind, "unchanged");
		assert.strictEqual(textOf(merged), existing);
		// 用户自定义的字段与自己的 timeout 都要保住
		const parsed = JSON.parse(existing);
		assert.deepStrictEqual(parsed.custom, { keep: true });
		assert.strictEqual(parsed.hooks.PreToolUse[0].timeout, 20);
	});

	test("解析不了的内容判 invalid，不产生覆盖写", () => {
		assert.strictEqual(mergeWechatNotifyHookJson("{ not json").kind, "invalid");
		assert.strictEqual(mergeWechatNotifyHookJson("[]").kind, "invalid");
		assert.strictEqual(mergeWechatNotifyHookJson('{"hooks": 5}').kind, "invalid");
		assert.strictEqual(mergeWechatNotifyHookJson('{"hooks": {"Stop": {}}}').kind, "invalid");
		assert.strictEqual(mergeWechatNotifyHookJson('{"hooks": {"PreToolUse": "x"}}').kind, "invalid");
	});

	test("hasWechatNotifyStopHook 只认指向通知脚本的条目", () => {
		const build = (command: string) =>
			JSON.stringify({ hooks: { Stop: [{ type: "command", command }] } });
		assert.strictEqual(hasWechatNotifyStopHook(undefined), false);
		assert.strictEqual(hasWechatNotifyStopHook(build(WECHAT_INTERACT_HOOK_COMMAND)), false);
		assert.strictEqual(hasWechatNotifyStopHook(build(WECHAT_NOTIFY_HOOK_COMMAND)), true);
	});
});
