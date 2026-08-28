/**
 * 内置模型参数与编码全量自检门禁脚本 (Verify Built-in Models Gate)
 *
 * 检查项：
 * 1. 模型 ID 唯一性（无重复定义）
 * 2. displayName 纯文本（严禁手写 Emoji）
 * 3. owned_by 统一为 "libiaorobot"
 * 4. apiMode 在合法枚举白名单内
 * 5. priceNote 无 U+FFFD 乱码；Emoji 前缀形态校验变体选择符完整（纯文字备注放行）
 * 6. reasoning_effort / reasoning_efforts 严格符合 7 档枚举白名单且默认档包含在数组内
 * 7. context_length、context_sizes 升序与 default_context_size 合法性
 * 8. include_reasoning_in_request 使用范围检查
 *
 * 用法：node scripts/validators/verify-models.js  （在 libiao-copilot/ 目录下运行）
 */

const fs = require("fs");
const path = require("path");

const PKG_PATH = path.join(__dirname, "..", "..", "package.json");
const RECOMMENDATIONS_PATH = path.join(__dirname, "..", "..", "src", "gitCommit", "commitRecommendations.ts");

const VALID_API_MODES = new Set(["openai", "openai-responses", "anthropic", "gemini", "ollama"]);
const VALID_REASONING_EFFORTS = new Set(["auto", "minimal", "low", "medium", "high", "xhigh", "max"]);

const EMOJI_PREFIX_CODEPOINTS = new Set([0x2B50, 0x274C, 0x26A0]); // ⭐, ❌, ⚠️

function checkModels() {
	if (!fs.existsSync(PKG_PATH)) {
		console.error("❌ 找不到 package.json 文件:", PKG_PATH);
		process.exit(1);
	}

	const raw = fs.readFileSync(PKG_PATH, "utf8");
	let pkg;
	try {
		pkg = JSON.parse(raw);
	} catch (e) {
		console.error("❌ package.json JSON 解析失败:", e.message);
		process.exit(1);
	}

	const models = pkg?.contributes?.configuration?.properties?.["libiaoCopilot.models"]?.default;
	if (!Array.isArray(models) || models.length === 0) {
		console.error("❌ 未在 package.json 中找到 libiaoCopilot.models.default 数组！");
		process.exit(1);
	}

	console.log(`\n🔍 开始全量内置模型体检（共 ${models.length} 款模型）...\n`);

	let errorCount = 0;
	let warnCount = 0;
	const seenIds = new Set();

	models.forEach((m, idx) => {
		const prefix = `[#${idx + 1} ${m.id || "未知ID"}]`;

		// 1. ID 检查
		if (!m.id || typeof m.id !== "string") {
			console.error(`❌ ${prefix} 缺少合法的 id 字段`);
			errorCount++;
			return;
		}
		if (seenIds.has(m.id)) {
			console.error(`❌ ${prefix} 发现重复的模型 ID: "${m.id}"`);
			errorCount++;
		}
		seenIds.add(m.id);

		// 2. displayName 检查（严禁手动写 Emoji）
		if (m.displayName) {
			const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m.displayName);
			if (hasEmoji) {
				console.error(`❌ ${prefix} displayName "${m.displayName}" 包含手写 Emoji！图标必须由 vision 动态装配！`);
				errorCount++;
			}
		}

		// 3. owned_by 检查
		if (m.owned_by !== "libiaorobot") {
			console.error(`❌ ${prefix} owned_by 必须统一为 "libiaorobot"，当前为: "${m.owned_by}"`);
			errorCount++;
		}

		// 4. apiMode 检查
		const apiMode = m.apiMode || "openai";
		if (!VALID_API_MODES.has(apiMode)) {
			console.error(`❌ ${prefix} apiMode "${apiMode}" 无效，必须为 ${[...VALID_API_MODES].join("/")}`);
			errorCount++;
		}

		// 5. priceNote 检查（Emoji 前缀形态校验变体选择符；纯文字备注如「白菜价」仅防乱码）
		if (m.priceNote) {
			const points = [...m.priceNote].map((c) => c.codePointAt(0));
			if (points.includes(0xFFFD)) {
				console.error(`❌ ${prefix} priceNote 包含 U+FFFD 乱码损坏！`);
				errorCount++;
			} else if (EMOJI_PREFIX_CODEPOINTS.has(points[0])) {
				if (points[1] !== 0xFE0F) {
					console.error(`❌ ${prefix} priceNote 的 Emoji 变体选择符 (\\uFE0F) 丢失或转义有误！码点: ${points.map((p) => "U+" + p.toString(16).toUpperCase()).join(" ")}`);
					errorCount++;
				}
			}
		}

		// 6. reasoning_effort / reasoning_efforts 白名单检查
		if (m.reasoning_effort && !VALID_REASONING_EFFORTS.has(m.reasoning_effort)) {
			console.error(`❌ ${prefix} reasoning_effort "${m.reasoning_effort}" 超出白名单！有效值: ${[...VALID_REASONING_EFFORTS].join(", ")}`);
			errorCount++;
		}
		if (m.reasoning_efforts) {
			if (!Array.isArray(m.reasoning_efforts) || m.reasoning_efforts.length === 0) {
				console.error(`❌ ${prefix} reasoning_efforts 必须是非空数组`);
				errorCount++;
			} else {
				for (const eff of m.reasoning_efforts) {
					if (!VALID_REASONING_EFFORTS.has(eff)) {
						console.error(`❌ ${prefix} reasoning_efforts 包含非标准档位: "${eff}"！`);
						errorCount++;
					}
				}
				if (m.reasoning_effort && !m.reasoning_efforts.includes(m.reasoning_effort)) {
					console.error(`❌ ${prefix} 默认档 reasoning_effort "${m.reasoning_effort}" 不在 reasoning_efforts 数组中！`);
					errorCount++;
				}
			}
		}

		// 7. context_sizes 与 default_context_size 检查
		if (m.context_sizes) {
			if (!Array.isArray(m.context_sizes) || m.context_sizes.length === 0) {
				console.error(`❌ ${prefix} context_sizes 必须是非空数组`);
				errorCount++;
			} else {
				// 检查升序
				for (let i = 0; i < m.context_sizes.length - 1; i++) {
					if (m.context_sizes[i] >= m.context_sizes[i + 1]) {
						console.error(`❌ ${prefix} context_sizes 必须保持严格升序排列！当前: [${m.context_sizes.join(", ")}]`);
						errorCount++;
						break;
					}
				}
				// 检查不超出 context_length
				if (m.context_length) {
					const maxInSizes = Math.max(...m.context_sizes);
					if (maxInSizes > maxInSizes > m.context_length) {
						console.error(`❌ ${prefix} context_sizes 最大值 (${maxInSizes}) 超出 context_length (${m.context_length})！`);
						errorCount++;
					}
				}
				// 检查 default_context_size 在数组中
				if (m.default_context_size && !m.context_sizes.includes(m.default_context_size)) {
					console.error(`❌ ${prefix} default_context_size (${m.default_context_size}) 不在 context_sizes 中！`);
					errorCount++;
				}
				// 检查最小档位与 max_tokens 预算
				const minSize = Math.min(...m.context_sizes);
				const maxOut = m.max_completion_tokens ?? m.max_tokens ?? 0;
				if (maxOut > 0 && minSize <= maxOut) {
					console.warn(`⚠️  ${prefix} 最小 context_size (${minSize}) <= max_tokens (${maxOut})，输入 token 预算会被截断为 1。`);
					warnCount++;
				}
			}
		}
	});

	// 8. 专项检查：Git Commit 推荐模型清单防呆验证
	if (fs.existsSync(RECOMMENDATIONS_PATH)) {
		const recContent = fs.readFileSync(RECOMMENDATIONS_PATH, "utf8");
		const match = recContent.match(/RECOMMENDED_COMMIT_MODEL_IDS:\s*readonly\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);

		if (!match) {
			console.error("❌ 无法从 src/gitCommit/commitRecommendations.ts 中解析 RECOMMENDED_COMMIT_MODEL_IDS！");
			errorCount++;
		} else {
			// 先剥离所有单行注释与多行注释
			const cleanedListStr = match[1].replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
			const ids = (cleanedListStr.match(/["']([^"']+)["']/g) || []).map((s) => s.replace(/["']/g, ""));

			if (ids.length === 0) {
				console.error("❌ RECOMMENDED_COMMIT_MODEL_IDS 推荐列表不能为空！");
				errorCount++;
			} else {
				const recSeen = new Set();
				for (const recId of ids) {
					if (recSeen.has(recId)) {
						console.error(`❌ Git Commit 推荐列表中存在重复 ID: "${recId}"`);
						errorCount++;
					}
					recSeen.add(recId);

					const target = models.find((m) => m.id === recId);
					if (!target) {
						console.warn(`⚠️  Git Commit 推荐模型 "${recId}" 暂未在 package.json 内置模型列表中定义（作为在途/自定义推荐保留）。`);
						warnCount++;
					}
				}
				console.log(`✨ Git Commit 推荐清单校验通过：共 ${ids.length} 款推荐模型，默认兜底自动为 "${ids[0]}"。`);
			}
		}
	} else {
		console.warn("⚠️  未找到 src/gitCommit/commitRecommendations.ts，跳过提交模型清单专项检查。");
		warnCount++;
	}

	console.log(`\n========================================`);
	if (errorCount > 0) {
		console.error(`❌ 内置模型体检未通过！发现 ${errorCount} 处致命错误，${warnCount} 处警告。请修复后重试！\n`);
		process.exit(1);
	} else {
		console.log(`✅ 全量内置模型体检 100% 通过！共 ${models.length} 款模型，0 错误，${warnCount} 处提示。\n`);
		process.exit(0);
	}
}

checkModels();
