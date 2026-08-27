---
description: 📝 维护 Git 提交信息推荐模型清单：直接打开配置文件并协助维护
name: lb-commit-model
argument-hint: [可选：修改说明或直接回车打开文件]
---

请进入 `libiao-copilot` 目录，在 VS Code 编辑器中直接打开 `src/gitCommit/commitRecommendations.ts` 文件。

并在对话中简要列出：
1. 当前已配置的推荐模型清单及首选兜底模型；
2. 开发者在文件中维护推荐列表（增删、调整顺序）的要点及执行门禁自检的命令（`npm run verify:models`）。

若提供了具体修改需求 `${input:actionDesc:可选：维护说明（如调整顺序、新增模型），直接回车则仅打开文件}`，则直接协助修改该文件并完成 `npm run verify:models` 门禁自检。
