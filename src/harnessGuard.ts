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
	update(section: string, key: string, value: boolean): Promise<void>;
}

const defaultConfigApi: HarnessConfigApi = {
	get(section, key) {
		return vscode.workspace.getConfiguration(section).get<boolean>(key);
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
 * - 用户随时可在设置里改回 `true`，或通过会话类型选择器临时切到 agent host。
 *
 * @returns 实际被改写的配置项全键名
 */
export async function suppressHarnessDefault(config: HarnessConfigApi = defaultConfigApi): Promise<string[]> {
	const corrected: string[] = [];

	for (const flag of HARNESS_DEFAULT_FLAGS) {
		if (config.get(flag.section, flag.key) !== true) {
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
