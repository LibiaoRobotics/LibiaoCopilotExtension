import type { HFModelItem } from "../types";
import { getBuiltInModels, parseModelId } from "../utils";

/**
 * ============================================================================
 * 🤖 Git Commit 推荐模型清单与准入规范 (Git Commit Model Recommendations)
 * ============================================================================
 *
 * 【开发者维护指南】
 * 开发者如需为插件新增、调整或移除 Git Commit 推荐模型，仅需直接维护下方的
 * `RECOMMENDED_COMMIT_MODEL_IDS` 数组，并运行 `npm run verify:models` 门禁自检。
 *
 * 【准入原则】
 * 1. ⚡ 快速响应：优先推荐响应迅速、性价比高且适合生成简短总结的模型；
 * 2. 🥇 优先级排序：数组元素严格按推荐优先级由高到低排列（排在第 1 位的作为全局默认兜底模型）。
 * ============================================================================
 */

/**
 * 全局默认兜底提交模型（必须与 RECOMMENDED_COMMIT_MODEL_IDS[0] 保持一致）
 */
export const DEFAULT_COMMIT_MODEL = "deepseek-v4-flash";

/**
 * 官方推荐用于生成 Git Commit Message 的模型 ID 白名单（严格按推荐优先级降序排列）
 */
export const RECOMMENDED_COMMIT_MODEL_IDS: readonly string[] = [
	"deepseek-v4-flash",
	// 将来如需扩充，可直接按优先级添加：
	// "gpt-4o-mini",
	// "claude-3-5-haiku",
];

/**
 * 获取适用于 Git Commit Message 的推荐模型列表（严格按推荐优先级排序）
 * @param userModels 用户配置的模型列表
 * @param builtInModels 内置模型表（可选，默认从 getBuiltInModels 获取）
 */
export function getRecommendedCommitModels(
	userModels: HFModelItem[],
	builtInModels?: Map<string, HFModelItem>
): HFModelItem[] {
	const builtIns = builtInModels ?? getBuiltInModels();
	const result: HFModelItem[] = [];
	const seen = new Set<string>();

	for (const id of RECOMMENDED_COMMIT_MODEL_IDS) {
		const { baseId, configId } = parseModelId(id);
		// 优先取用户配置中完全匹配 (baseId + configId) 的模型
		let model = userModels.find(
			(m) => m.id === baseId && (configId ? m.configId === configId : !m.configId)
		);
		// 若无精确匹配，尝试查找用户配置的同 baseId 模型（覆盖内置）
		if (!model && !configId) {
			model = userModels.find((m) => m.id === baseId);
		}
		// 若用户未配置，则从内置模型表中兜底
		if (!model) {
			model = builtIns.get(baseId);
		}
		if (model) {
			const key = `${model.id}::${model.configId ?? ""}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push(model);
			}
		}
	}
	return result;
}

/**
 * 校验并纠偏 commitModel，若传入的模型不在推荐列表内，则自动回退至首选推荐模型
 * @param currentModelId 当前配置中的模型 ID
 * @param availableCommitModels 当前环境中可用的推荐模型列表
 */
export function resolveValidCommitModel(
	currentModelId: string | undefined,
	availableCommitModels: HFModelItem[]
): string {
	if (
		currentModelId &&
		availableCommitModels.some((m) => {
			const fullId = `${m.id}${m.configId ? "::" + m.configId : ""}`;
			return fullId === currentModelId || m.id === currentModelId;
		})
	) {
		return currentModelId;
	}
	// 回退到第一个推荐可用模型或默认值
	if (availableCommitModels.length > 0) {
		const first = availableCommitModels[0];
		return `${first.id}${first.configId ? "::" + first.configId : ""}`;
	}
	return DEFAULT_COMMIT_MODEL;
}
