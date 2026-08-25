---
description: 🚀 编译代码、跑测试、打包 VSIX 并通过专属脚本一键安装到本地 VS Code
---

请严格按照 `extension-lifecycle` 技能的 SOP 流水线，帮我执行：
1. 编译当前 TypeScript 源码并进行类型检查；
2. 运行自动化单元测试（确保全量用例 PASS）；
3. 执行 `npm run build` 打包 `extension.vsix`（严禁 --no-dependencies）；
4. 运行 `pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1` 一键安装到本地；
5. 完成后提醒我完全重启 VS Code。
