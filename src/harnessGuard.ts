import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * 会把「新建会话默认类型」推向实验性 agent host 的配置项。
 * 判定逻辑见 VS Code `src/vs/workbench/contrib/chat/common/constants.ts` 的
 * `isCopilotHarnessDefault` / `isCopilotHarnessPreferred`。
 */
export interface HarnessFlag {
	readonly section: string;
	readonly key: string;
	readonly fullKey: string;
}

export const HARNESS_DEFAULT_FLAGS: readonly HarnessFlag[] = [
	{ section: "chat", key: "defaultToCopilotHarness", fullKey: "chat.defaultToCopilotHarness" },
	{ section: "chat.editor", key: "preferCopilotHarness", fullKey: "chat.editor.preferCopilotHarness" },
];

/** 配置文件读写的最小接口，便于单测注入，避免依赖真实 VS Code 配置服务。 */
export interface HarnessConfigApi {
	get(section: string, key: string): boolean | undefined;
	/** 用户层（Global）显式值；`undefined` 表示用户从未设置，当前值来自默认层或实验层。 */
	getGlobalValue(section: string, key: string): boolean | undefined;
	update(section: string, key: string, value: boolean): Promise<void>;
}

const defaultConfigApi: HarnessConfigApi = {
	get(section, key) {
		return vscode.workspace.getConfiguration(section).get<boolean>(key);
	},
	getGlobalValue(section, key) {
		return vscode.workspace.getConfiguration(section).inspect<boolean>(key)?.globalValue;
	},
	async update(section, key, value) {
		await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
	},
};

/**
 * 把被实验推上去的 harness 默认值压回本地会话。
 *
 * 只写入用户层（Global），因此：
 * - 实验注入在 DEFAULT 层，用户层显式 `false` 必然覆盖它；
 * - 用户自己在用户层把开关设成 `true`（显式选择 agent host）时不抢回，避免每次启动覆盖用户意愿。
 *
 * @returns 实际被改写的配置项全键名
 */
export async function suppressHarnessDefault(config: HarnessConfigApi = defaultConfigApi): Promise<string[]> {
	const corrected: string[] = [];

	for (const flag of HARNESS_DEFAULT_FLAGS) {
		if (config.get(flag.section, flag.key) !== true) {
			continue;
		}
		if (config.getGlobalValue(flag.section, flag.key) === true) {
			continue;
		}
		try {
			await config.update(flag.section, flag.key, false);
			corrected.push(flag.fullKey);
		} catch (err) {
			logger.warn("harness.guard.updateFailed", { key: flag.fullKey, error: String(err) });
		}
	}

	if (corrected.length > 0) {
		logger.info("harness.guard.corrected", { keys: corrected });
	}
	return corrected;
}

/**
 * 启动时压一次并持续监听。
 *
 * 实验值（`experiment.mode: startup`）与扩展激活的先后顺序不保证，一次性调用会漏；
 * 自身写入 `false` 会让有效值变为 `false`，因此监听回调自然幂等，不会形成写循环。
 */
export function registerHarnessGuard(): vscode.Disposable {
	const listener = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!HARNESS_DEFAULT_FLAGS.some((flag) => e.affectsConfiguration(flag.fullKey))) {
			return;
		}
		void suppressHarnessDefault();
	});
	void suppressHarnessDefault();
	return listener;
}
