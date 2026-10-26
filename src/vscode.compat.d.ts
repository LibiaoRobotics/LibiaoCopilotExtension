/*---------------------------------------------------------------------------------------------
 * 兼容声明层（不参与 JS 输出）。
 *
 * 目的：在**不升级** `@types/vscode`（当前锁定 1.104）、**不抬高** `engines.vscode`
 * 的前提下，声明扩展已经开始使用、但本地 vendored 提案文件里尚未包含的可选字段。
 *
 * 与上游声明逐字对齐：
 *   - `vscode.proposed.chatProvider.d.ts`（`includeEncryptedThinking` / `maxContextWindowTokens`）
 *   - `vscode.proposed.languageModelPricing.d.ts`（`pricing` 及其配套字段）
 *
 * 运行时纪律：这些字段一律按**可选**处理。旧版 VS Code 不下发时保持原有行为，
 * 绝不无条件访问。
 *
 * 注意：`languageModelCapabilities` 提案（`capabilities.apiType` / `adaptiveThinking`）
 * 刻意**不声明、不使用**。宿主对 `capabilities.apiType !== undefined` 会调用
 * `checkProposedApiEnabled(extension, 'languageModelCapabilities')` 并**抛出**，
 * 且该检查位于逐个模型的 `map` 内 —— 一旦宿主存在该提案但未对扩展开启
 * （例如手动安装 VSIX、argv.json 未写入），整份模型列表注册失败，
 * 模型选择器里一个模型都不剩。其收益（仅影响「延续任务」场景的历史思考重放）
 * 远小于风险，故不启用。
 *--------------------------------------------------------------------------------------------*/

declare module "vscode" {
	export interface LanguageModelChatInformation {
		/**
		 * 模型上下文窗口总长度（输入 + 输出），独立于 `maxInputTokens` / `maxOutputTokens`，
		 * 后两者之和不必等于该值。
		 */
		readonly maxContextWindowTokens?: number;

		/** 展示用的价格标签，例如 "Free"、"$0.01/request"。 */
		readonly pricing?: string;

		/** 相对价格档位（low / medium / high / very_high），用于模型选择器的视觉标记。 */
		readonly priceCategory?: string;

		/** 模型档次标签（lightweight / versatile / powerful）。 */
		readonly category?: string;
	}

	export interface ProvideLanguageModelChatResponseOptions {
		/** 宿主是否要求响应中携带可跨轮重放的加密思考状态。 */
		readonly includeEncryptedThinking?: boolean;
	}
}
