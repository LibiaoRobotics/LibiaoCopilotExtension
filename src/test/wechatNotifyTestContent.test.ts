import * as assert from "assert";
import { buildWechatNotifyTestContent } from "../wechatNotifyTest";

/**
 * 回归测试：企微联动测试消息正文。
 *
 * 「来源」一行的用途是让群里的人分清这条测试是谁发的——
 * 多个项目共用一个群时，只有时间戳根本判断不了。
 */
suite("企微联动测试消息正文", () => {
	const now = new Date(2026, 9, 30, 13, 55, 29);

	test("给了项目名时，时间行之前插入「来源：<项目名>」", () => {
		assert.strictEqual(
			buildWechatNotifyTestContent(now, "LibiaoCopilot"),
			[
				"🔔 企微联动连通性测试",
				"这是从 VS Code 面板手动发出的测试消息，不是对话结束通知。",
				"来源：LibiaoCopilot",
				"时间：2026-10-30 13:55:29",
			].join("\n")
		);
	});

	test("项目名两端空白被去掉", () => {
		const content = buildWechatNotifyTestContent(now, "  LibiaoCopilot  ");
		assert.ok(content.includes("\n来源：LibiaoCopilot\n"));
		assert.ok(!content.includes("  LibiaoCopilot"));
	});

	test("拿不到项目名时不写来源行，也不留空行", () => {
		const expected = [
			"🔔 企微联动连通性测试",
			"这是从 VS Code 面板手动发出的测试消息，不是对话结束通知。",
			"时间：2026-10-30 13:55:29",
		].join("\n");
		assert.strictEqual(buildWechatNotifyTestContent(now, undefined), expected);
		assert.strictEqual(buildWechatNotifyTestContent(now, "   "), expected);
	});
});
