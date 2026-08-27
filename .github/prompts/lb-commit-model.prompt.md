---
description: 📝 维护 Git 提交信息推荐模型清单：增删调序、单一源维护与门禁回归
name: lb-commit-model
argument-hint: [操作说明/推荐模型列表，如: 将 deepseek-v4-flash 设为首选，并新增 xxx]
---

请帮助维护 Libiao Copilot 插件的 Git 提交信息推荐模型清单：

目标需求：`${input:actionDesc:维护说明（如：调整推荐顺序、新增推荐模型 ID 等）}`

执行标准流程：
step 1：核对模型有效性。检查目标模型 ID 是否在 `package.json` 的 `libiaoCopilot.models.default` 中已存在；若为新模型，需确认其已被正确声明；
step 2：维护单一配置源。编辑 `src/gitCommit/commitRecommendations.ts`，在 `RECOMMENDED_COMMIT_MODEL_IDS` 数组中增删或调整模型顺序，并确保 `DEFAULT_COMMIT_MODEL` 常量与数组首项保持严格一致；
step 3：执行门禁自检。在 `libiao-copilot` 目录下运行 `npm run verify:models`，确保推荐列表校验通过（无拼写错误、无重复、无悬空 ID）；
step 4：执行全量测试。运行 `npm test`（或相关单测）确保编译与行为回归无异常。
