import * as assert from "assert";
import * as vscode from "vscode";
import {
	parsePowerShellVersion,
	getStandardWindowsPwshPaths,
	getPowerShellInstallCommand,
	isPowerShellDefaultProfile,
	getPowerShellStatus,
	promptPowerShellSetupIfNeeded,
	schedulePowerShellPrompt,
	POWERSHELL_PROMPT_SUPPRESS_KEY,
} from "../powershellManager";

class MockMemento implements vscode.Memento {
	private storage = new Map<string, any>();
	keys(): readonly string[] {
		return Array.from(this.storage.keys());
	}
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		if (this.storage.has(key)) {
			return this.storage.get(key) as T;
		}
		return defaultValue;
	}
	update(key: string, value: any): Thenable<void> {
		this.storage.set(key, value);
		return Promise.resolve();
	}
	setKeysForSync(_keys: readonly string[]): void {}
}

suite("PowerShell Manager Tests", () => {
	test("parsePowerShellVersion: 正确解析版本号与过滤旧版本", () => {
		assert.strictEqual(parsePowerShellVersion("PowerShell 7.6.5"), "7.6.5");
		assert.strictEqual(parsePowerShellVersion("7.4.2"), "7.4.2");
		assert.strictEqual(parsePowerShellVersion("PowerShell 7.5.0-preview.3\n"), "7.5.0-preview.3");
		assert.strictEqual(parsePowerShellVersion("PowerShell 7.0.0"), "7.0.0");
		// 5.1 不是 PowerShell 7，应返回 null
		assert.strictEqual(parsePowerShellVersion("Major  Minor  Build  Revision\n-----  -----  -----  --------\n5      1      26100  1"), null);
		assert.strictEqual(parsePowerShellVersion("Windows PowerShell 5.1"), null);
		assert.strictEqual(parsePowerShellVersion(""), null);
	});

	test("getStandardWindowsPwshPaths: 获取 Windows 常见安装候选路径", () => {
		const paths = getStandardWindowsPwshPaths();
		assert.ok(Array.isArray(paths) && paths.length > 0, "路径列表应为非空数组");
		for (const p of paths) {
			assert.ok(p.toLowerCase().endsWith("pwsh.exe"), `路径应以 pwsh.exe 结尾: ${p}`);
		}
	});

	test("getPowerShellInstallCommand: 生成包含 winget 与官方回退的复合安装脚本", () => {
		const cmd = getPowerShellInstallCommand();
		assert.ok(cmd.includes("Microsoft.PowerShell"), "命令应包含 Microsoft.PowerShell 安装 ID");
		assert.ok(cmd.includes("winget install"), "命令应包含 winget 安装调用");
		assert.ok(cmd.includes("aka.ms/install-powershell.ps1"), "命令应包含官方脚本兜底");
	});

	test("isPowerShellDefaultProfile: 返回布尔值", () => {
		const isDefault = isPowerShellDefaultProfile();
		assert.strictEqual(typeof isDefault, "boolean");
	});

	test("getPowerShellStatus: 在当前测试环境中成功探测状态", async () => {
		const status = await getPowerShellStatus();
		assert.ok(status, "状态对象不应为空");
		assert.strictEqual(typeof status.installed, "boolean");
		assert.strictEqual(typeof status.platform, "string");
		if (status.installed) {
			assert.ok(status.version.startsWith("7."), `版本号应以 7. 开头，实际为: ${status.version}`);
			assert.ok(status.executablePath.length > 0, "可执行文件路径不应为空");
		}
	});

	test("promptPowerShellSetupIfNeeded: 非 Windows 平台静默跳过", async () => {
		const memento = new MockMemento();
		let prompted = false;
		const mockShow = async () => {
			prompted = true;
			return undefined;
		};
		const resMac = await promptPowerShellSetupIfNeeded(memento, "darwin", mockShow);
		const resLinux = await promptPowerShellSetupIfNeeded(memento, "linux", mockShow);
		assert.strictEqual(resMac, "none");
		assert.strictEqual(resLinux, "none");
		assert.strictEqual(prompted, false, "非 Windows 不应触发任何弹窗");
	});

	test("promptPowerShellSetupIfNeeded: 已设置不再提示时跳过", async () => {
		const memento = new MockMemento();
		await memento.update(POWERSHELL_PROMPT_SUPPRESS_KEY, true);
		let prompted = false;
		const mockShow = async () => {
			prompted = true;
			return undefined;
		};
		const res = await promptPowerShellSetupIfNeeded(memento, "win32", mockShow);
		assert.strictEqual(res, "skipped");
		assert.strictEqual(prompted, false, "已抑制时不应触发弹窗");
	});

	test("promptPowerShellSetupIfNeeded: 用户点击不再提示时持久化状态", async () => {
		const memento = new MockMemento();
		const mockShow = async (_msg: string, ..._items: string[]) => {
			return "不再提示";
		};
		await promptPowerShellSetupIfNeeded(memento, "win32", mockShow);
		assert.strictEqual(memento.get<boolean>(POWERSHELL_PROMPT_SUPPRESS_KEY), true, "点击不再提示应更新状态");
	});

	test("schedulePowerShellPrompt: 正确注册 Disposable 与定时器生命周期", () => {
		const subscriptions: vscode.Disposable[] = [];
		const mockContext = {
			subscriptions,
			globalState: new MockMemento(),
		} as unknown as vscode.ExtensionContext;

		const disposable = schedulePowerShellPrompt(mockContext, 10000);
		assert.strictEqual(subscriptions.length, 1, "应注册到 subscriptions");
		disposable.dispose();
	});
});
