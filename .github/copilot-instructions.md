# Libiao Copilot 仓库指令总纲

本文件只定义**仓库级红线**与**领域能力路由**；具体机制与命令一律下沉到 `instructions/`、`skills/`、`prompts/`、`agents/`。新增规则时优先放入对应子文件，本总纲仅保留一行摘要与链接。

---

## 1. 🚨 仓库红线

1. **讨论与行动边界**：未收到明确执行指令前保持只读，严禁擅自编辑、重写历史、推送或删除文件。
2. **执行目录与参考工程**：所有命令必须在 `libiao-copilot/` 下执行；`vscode-src/`、`vscode-docs/` 为**只读参考**，严禁修改或在其下构建。
3. **终端与脚本**：统一 `pwsh`（禁用 Windows PowerShell 5.1），`.ps1` 必须含 UTF-8 BOM。详见 [powershell-env](.github/instructions/powershell-env.instructions.md)。
4. **网关安全**：默认 `baseUrl` 必须留空，严禁硬编码内部网关地址。详见 [gateway](.github/instructions/gateway.instructions.md)。
5. **打包与安装**：打包统一 `npm run build`（不加 `--no-dependencies`）；本地安装仅限 `pwsh -File .\scripts\Install-LibiaoCopilot.ps1`。详见 [powershell-env](.github/instructions/powershell-env.instructions.md)。
6. **脚本目录收敛**：严禁在 `scripts/` 根目录新建脚本；必须归入 `probes/`、`analyzers/`、`replay/` 或新建自解释子目录，并在 `scripts/README.md` 同步登记。
7. **Changelog 用户视角纪律**：`CHANGELOG.md` 只记录对用户可见的功能、改进与修复；严禁写入代码重构、配置源抽离、门禁脚本、测试用例等开发侧细节。
8. **海量日志与数据流上下文隔离**：大体量日志排障、长报文/抓包分析、批量诊断必须委派子智能体闭环处理，主会话只接收提炼后的结构化结论（根因、关键行号、修复方案）。
9. **实参锚定**：机制分析、性能评估、架构建议必须先核验真实现场配置与数值边界（`context_length`、`context_sizes`、真实触发水位），并严格区分「常态高频路径」与「低频极端兜底」，禁止把几乎不触发的兜底夸大为日常痛点。
10. **AI 记忆写入边界**：本项目的任何记忆、经验、外部事实与协作约定，**严禁写入 repo memory（`/memories/repo/`）**，只允许写入仓库内 `.github/`。理由：repo memory 绑定本机工作区哈希，换目录即失效、无法随仓库版本化与评审。
    - 分流：跨文件通用约束 → 本总纲；按路径生效的代码约束 → `instructions/`（必须配 `applyTo`）；多步复杂流程 → `skills/`（必须含验证闭环）；一次性上下文 → 会话内说明，**不落仓库**。
    - 写入前必须先能回答「不写会导致什么具体错误行为」，答不出则不写；一次性失误不立永久规则。
11. **安装动作必须回报**：任何安装、重装或覆盖安装本插件的行为（`Install-LibiaoCopilot.ps1`、安装 `.vsix`、手工替换扩展目录、卸载后重装），都必须在**最终回复中显式告知**「已重装插件」，并说明是否需要重载窗口。只跑不说会让特哥分不清当前会话跑的是旧版还是新版代码，后续现象归因与排查方向会整条跑偏。详见 [extension-lifecycle](.github/skills/extension-lifecycle/SKILL.md)。

---

## 2. 🧭 领域指示与技能路由

### 📘 模块化指示 (`.github/instructions/`)

| 文件 | `applyTo` | 覆盖范围 |
|---|---|---|
| [architecture](.github/instructions/architecture.instructions.md) | `**/*.ts` | 架构分层、模型合并发现、提案 API、上下文管理、版本跃迁迁移 |
| [streaming-protocols](.github/instructions/streaming-protocols.instructions.md) | `src/{openai,anthropic,gemini,ollama}/**/*.ts` | 多协议适配与思考泄漏守卫 |
| [powershell-env](.github/instructions/powershell-env.instructions.md) | `**/*.{ps1,bat,cmd,json}` | pwsh 约束、编码防损、安装与发版一致性 |
| [gateway](.github/instructions/gateway.instructions.md) | `scripts/**` | NewAPI 地址/鉴权、Key 权限边界、`model_not_found` 判定红线 |
| [vscode-host](.github/instructions/vscode-host.instructions.md) | `src/**/*.ts` | BYOK / Agent Host 机制、只读参考仓库、双 bundle 取证纪律 |
| [wechat-bridge](.github/instructions/wechat-bridge.instructions.md) | `**/wechatBridge*.ts`、`**/WechatNotify*.ps1` | 企微双向数据流、正文来源（transcripts 优先）、`chat.open` 语义、协议事实与安全不变量 |

### ⚡ 场景化技能 (`.github/skills/`)

- **`extension-lifecycle`**：编译、单测、打包与一键安装工作流。
- **`github-release`**：GitHub Release 自动化发布。
- **`stream-diagnostics`**：流式抓包与 NewAPI 异构网关排障。
- **`safe-unicode-edit`**：Emoji 码点转义与跨目录文件安全移动。
- **`add-builtin-model`**：新增/修改内置模型、effort 挡位与 priceNote 成本标注。
- **`model-benchmark`**：网关批量连通性、TTFT 首字延迟与 TPS 压测。

### 🤖 专项智能体 (`.github/agents/`)

- **`Stream-Replay-Debugger`**：流式协议抓包重放、思考泄漏、断流与状态机深度诊断子智能体（隔离海量原始报文噪声）。

