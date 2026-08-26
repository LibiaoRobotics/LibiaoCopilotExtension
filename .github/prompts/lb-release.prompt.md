---
description: 📦 发版流水线：改版本号与 CHANGELOG、测试、打包、本地安装、提交 GitHub、打注解标签并发布 Release
name: lb-release
argument-hint: [版本号，必填，如 1.3.0]
---

请进入 `libiao-copilot` 目录，严格按照 `extension-lifecycle` 与 `github-release` 技能的 SOP 执行发版流水线。

**参数校验（第 0 步，先于一切操作）**：
- 目标版本号为 `${input:version:目标版本号，必填，如 1.3.0}`。
- 若版本号为空、未提供或不符合 `X.Y.Z` 格式（如 `1.3`、`v1.3.0`），**立即终止任务**，不执行任何修改、命令或推送，并提示特哥重新提供正确格式的版本号。

1. **现状核验（只读）**：检查 `package.json` 当前 version、`CHANGELOG.md` 顶部段落、`git status` 与最近提交，向特哥简要汇报后继续。
2. **改版本号**：将 `package.json` 的 `version` 改为目标版本号（不带 `v`）。
3. **改 CHANGELOG**：在顶部新增 `## 目标版本号` 段落（不带 `v`、与现有格式一致，三级分类为「新增 / 改进 / 修复」）。内容以自上版本标签以来的 `git log` 为素材自动提炼摘要，措辞风格与既有 CHANGELOG 条目保持一致；如 git log 难以覆盖明显改动，向特哥确认后补充。
4. **测试**：`npm run compile` + `npm test`，全量用例必须 PASS；失败则定位修复后重跑，严禁跳过。
5. **打包**：`npm run build`（严禁 `--no-dependencies`），产物为 `extension.vsix`。
6. **本地安装**：`pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1`。
7. **提交并推送 GitHub**：`git status` 确认变更清单无意外文件（如 `extension.vsix` 已被 .gitignore 排除）后，`git add -A` 并 commit（message 格式 `release: vX.Y.Z`），推送 `origin main`。
8. **打注解标签并推送**：`git tag -a vX.Y.Z -m "release: vX.Y.Z"`，然后 `git push origin vX.Y.Z`。
9. **发布 Release**：`pwsh -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z`；若报「无法获取 GitHub token」，提示特哥先在终端执行一次 `git push`（或通过 Git Credential Manager 登录一次）后重试。
10. **线上核验**：用 Node.js 请求 GitHub API 抓取线上 Release 的 body，确认内容完整、中文无乱码。
11. 完成后提醒特哥：**完全退出 VS Code（关闭所有窗口）再重新打开**，以让新版本插件生效。
