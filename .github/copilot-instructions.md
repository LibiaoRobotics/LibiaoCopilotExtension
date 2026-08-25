# Libiao Copilot 指令总纲与开发规约 (Copilot Instructions)

本文件是 Libiao Copilot 仓库级核心指导总纲，定义全局红线与领域能力路由。

---

## 1. 🚨 核心红线与铁律（违反必翻车）

1. **工作区目录隔离**：工作区根目录不是 Git 仓库！所有 `git`、`npm`、`npx`、构建与测试指令**必须在 `libiao-copilot/` 仓库目录下执行**。
2. **PowerShell 7 (`pwsh`) 规范**：全套脚本、VS Code Tasks 及 CLI 指令**统一使用 `pwsh`（PowerShell 7+）**，严禁使用旧版 `powershell.exe`（5.1）。`.ps1` 脚本必须包含 **UTF-8 BOM 头（`0xEF, 0xBB, 0xBF`）**。
3. **VSIX 打包依赖完整性**：打包唯一路径为 `libiao-copilot/extension.vsix`（执行 `npm run build`）。**严禁添加 `--no-dependencies`**（保留 `@microsoft/tiktokenizer` 运行时依赖）。
4. **本地安装唯一合法指令**：严禁直接敲 `code --install-extension`。必须执行：
   ```powershell
   pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1
   ```
5. **版本号与 Git Tag 铁律**：未经特哥明确指令，**严禁私自修改 `package.json` 中的 `version` 字段**。Git Tag **一律打注解标签**：`git tag -a vX.Y.Z -m "release: vX.Y.Z"`。
6. **测试验证铁律（“写了测试” $\neq$ “测过”）**：交付前**必须真实跑通 `npm test` 并确认全部用例 PASS**。怀疑有残留时先清空 `out/` 重新 `npm run compile`。
7. **隐私与密钥安全**：公司网关 URL 不得硬编码到代码库（默认 `baseUrl` 留空）；密钥与 Token 严禁写入代码、注释、提交历史或日志。

---

## 2. 🧭 领域指示与技能路由表 (Instructions & Skills)

AI 助手在执行具体任务时，按需查阅对应目录下的标准规范：

### 📘 模块化开发指示 (`.github/instructions/`)
- **[系统架构与核心机制](.github/instructions/architecture.instructions.md)**：架构分层、模型合并发现机制、提案 API、上下文管理。
- **[多协议流式与思考规范](.github/instructions/streaming-protocols.instructions.md)**：OpenAI Responses、Anthropic、Gemini、XML Inline 思考解析、泄漏守卫。
- **[PowerShell 运行环境与脚本规约](.github/instructions/powershell-env.instructions.md)**：PowerShell 7 标准、脚本自愈提升、文件编码防损。

### ⚡ 场景化可执行技能 (`.github/skills/`)
- **`extension-lifecycle`**：插件编译、全量单元测试、VSIX 打包与本地一键安装工作流。
- **`github-release`**：注解标签（Annotated Git Tag）与 GitHub Release 自动化发布。
- **`stream-diagnostics`**：流式协议抓包调试、NewAPI 异构网关慢性病排查与日志分析。
- **`safe-unicode-edit`**：Emoji 码点转义、PowerShell 脚本编码防损与跨目录文件安全移动。
- **`add-builtin-model`**：新增/修改内置模型条目、配置 reasoning effort 挡位与 priceNote 成本标注。
- **`model-benchmark`**：网关模型批量连通性探测、TTFT 首字延迟与 TPS 压测。

---

## 3. 🛠️ 常用开发与构建速查命令

```powershell
# 1. 编译与检查
npm run compile        # 编译 TypeScript 源码
npm run lint           # 执行 ESLint 校验
npm run format         # Prettier 代码格式化

# 2. 自动化测试
npm test               # 编译并运行全量自动化单元测试（vscode-test）

# 3. 打包构建
npm run build          # 打包生成 extension.vsix（包含完整 node_modules 运行时依赖）

# 4. 本地一键安装
pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1

# 5. GitHub Release 自动化发布
pwsh -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z
```
