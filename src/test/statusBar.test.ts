import * as assert from "assert";
import * as vscode from "vscode";
import { updateWechatNotifyStatusBar } from "../statusBar";
import { DEFAULT_WECHAT_NOTIFY_SETTINGS, type WechatNotifySettings } from "../wechatNotifySettings";
import type { WechatNotifyConfigState } from "../wechatNotifyConfig";
import type { WechatNotifyHookPresence, WechatNotifyScriptInfo } from "../wechatNotifyHookSetup";

/**
 * 回归测试：企微联动状态栏文案与颜色。
 *
 * 「未创建」用黄色 × 加「企微未联动」双信号：黄色提醒需要动手，
 * 文字说清还没接上——只靠图标的话用户容易以为联动已在工作。
 */

function fakeItem(): vscode.StatusBarItem {
	return { text: "", color: undefined, tooltip: undefined } as unknown as vscode.StatusBarItem;
}

/** ThemeColor 的主题色 id，没设色时为 undefined */
function colorId(item: vscode.StatusBarItem): string | undefined {
	return (item.color as { id?: string } | undefined)?.id;
}

function stateWith(settings: Partial<WechatNotifySettings>): WechatNotifyConfigState {
	return {
		settings: { ...DEFAULT_WECHAT_NOTIFY_SETTINGS, ...settings },
		configPath: "c:/ws/.github/hooks/WechatNotify.local.psd1",
		exists: true,
	};
}

const READY_PRESENCE: WechatNotifyHookPresence = {
	json: true,
	script: true,
	config: true,
	interact: true,
};
const MISSING_PRESENCE: WechatNotifyHookPresence = {
	json: false,
	script: false,
	config: false,
	interact: false,
};

suite("企微联动状态栏文案", () => {
	test("未创建：图标与文字均为黄色，文案为「企微未联动」", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(
			item,
			stateWith({ enabled: true, webhook: "https://example.com/hook" }),
			MISSING_PRESENCE
		);
		assert.strictEqual(item.text, "$(close) 企微未联动");
		assert.strictEqual(colorId(item), "charts.yellow");
	});

	test("已启用：图标 bell，文案仍是「企微联动」，且不叠状态色", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(
			item,
			stateWith({ enabled: true, webhook: "https://example.com/hook" }),
			READY_PRESENCE
		);
		assert.strictEqual(item.text, "$(bell) 企微联动");
		assert.strictEqual(colorId(item), undefined);
	});

	test("未启用：图标 bell-slash，文案仍是「企微联动」，用灰色", () => {
		const item = fakeItem();
		updateWechatNotifyStatusBar(item, stateWith({ enabled: false, webhook: "" }), READY_PRESENCE);
		assert.strictEqual(item.text, "$(bell-slash) 企微联动");
		assert.strictEqual(colorId(item), "disabledForeground");
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
		assert.strictEqual(item.text, "$(close) 企微未联动");
		assert.strictEqual(colorId(item), "charts.yellow");
	});
});
