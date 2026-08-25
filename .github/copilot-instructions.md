# Libiao Copilot 仓库指令总纲

本文件定义仓库特有的核心执行红线与领域能力路由。

---

## 1. 🚨 仓库红线

1. **讨论与行动边界**：严禁擅自发起编辑或修改；默认处于讨论状态，必须收到明确执行指令后方可动手。
2. **执行目录**：工作区根目录非 Git 仓库，所有命令必须在 `libiao-copilot/` 目录下执行。
3. **终端与脚本**：CLI/任务必须统一使用 `pwsh`（禁用 Windows PowerShell 5.1）；`.ps1` 脚本必须含 UTF-8 BOM。
4. **打包与安装**：打包统一为 `npm run build`（保留运行时依赖）；本地安装仅限 `pwsh -File .\scripts\Install-LibiaoCopilot.ps1`（禁止直接使用 `code --install-extension`）。
5. **网关安全**：默认 `baseUrl` 必须留空，严禁硬编码内部网关地址。

---

## 2. 🧭 领域指示与技能路由

### 📘 模块化指示 (`.github/instructions/`)

- **[系统架构与核心机制](.github/instructions/architecture.instructions.md)**：架构分层、模型合并发现、提案 API 与上下文管理。
- **[多协议流式与思考规范](.github/instructions/streaming-protocols.instructions.md)**：协议适配（OpenAI/Anthropic/Gemini/XML）与思考泄漏守卫。
- **[PowerShell 运行环境与脚本规约](.github/instructions/powershell-env.instructions.md)**：PowerShell 7 约束与编码防损。

### ⚡ 场景化技能 (`.github/skills/`)

- **`extension-lifecycle`**：编译、单测、打包与一键安装工作流。
- **`github-release`**：GitHub Release 自动化发布。
- **`stream-diagnostics`**：流式抓包与 NewAPI 异构网关排障。
- **`safe-unicode-edit`**：Emoji 码点转义与跨目录文件安全移动。
- **`add-builtin-model`**：新增/修改内置模型、effort 挡位与 priceNote 成本标注。
- **`model-benchmark`**：网关批量连通性、TTFT 首字延迟与 TPS 压测。
