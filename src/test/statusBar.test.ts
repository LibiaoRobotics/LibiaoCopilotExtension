import * as assert from "assert";
import * as vscode from "vscode";
import { updateWechatNotifyStatusBar } from "../statusBar";
import { DEFAULT_WECHAT_NOTIFY_SETTINGS, type WechatNotifySettings } from "../wechatNotifySettings";
import type { WechatNotifyConfigState } from "../wechatNotifyConfig";
import type { WechatNotifyHookPresence, WechatNotifyScriptInfo } from "../wechatNotifyHookSetup";

/**
 * 回归测试：企微联动状态栏文案。
 *
 * 「未创建」的图标不带状态色，光看 $(broadcast) 读不出还没接上，
 * 所以文字必须自己说明——否则用户会以为联动已在工作。
 */

function fakeItem(): vscode.StatusBarItem {
	return { text: "", color: undefined, tooltip: undefined } as unknown as vscode.StatusBarItem;
}

function stateWith(settings: Partial<WechatNotifySettings>): WechatNotifyConfigState {
	return {
		settings: { ...DEFAULT_WECHAT_NOTIFY_SETTINGS, ...settings },
		configPath: "c:/ws/.github/hooks/WechatNotify.local.psd1",
		exists: true,
	};
}

const READY_PRESENCE: WechatNotifyHookPresence = { json: true, script: true, config: true };
const MISSING_PRESENCE: WechatNotifyHookPresence = { json: false, script: false, config: false };

suite("企微联动状态栏文案", () => {
	test("未创建：保留广播图标，文案为「企微未联动」", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(
			item,
			stateWith({ enabled: true, webhook: "https://example.com/hook" }),
			MISSING_PRESENCE
		);
		assert.strictEqual(item.text, "$(broadcast) 企微未联动");
	});

	test("已启用：图标 bell，文案仍是「企微联动」", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(
			item,
			stateWith({ enabled: true, webhook: "https://example.com/hook" }),
			READY_PRESENCE
		);
		assert.strictEqual(item.text, "$(bell) 企微联动");
	});

	test("未启用：图标 bell-slash，文案仍是「企微联动」", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(item, stateWith({ enabled: false, webhook: "" }), READY_PRESENCE);
		assert.strictEqual(item.text, "$(bell-slash) 企微联动");
	});

	test("未打开工作区：图标 circle-slash，文案仍是「企微联动」", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(item, stateWith({ enabled: true, webhook: "https://example.com/hook" }), READY_PRESENCE, undefined, false);
		assert.strictEqual(item.text, "$(circle-slash) 企微联动");
	});

	test("未创建：不叠「待升级」箭头，避免两种信号互相干扰", () => {
		const item = fakeItem();
		const outdatedScript: WechatNotifyScriptInfo = {
			status: "outdated",
			installedVersion: "1.0.0",
			templateVersion: "1.1.0",
			identical: false,
		};
		updateWechatNotifyStatusBar(
			item,
			stateWith({ enabled: true, webhook: "https://example.com/hook" }),
			MISSING_PRESENCE,
			outdatedScript
		);
		assert.strictEqual(item.text, "$(broadcast) 企微未联动");
	});
});
