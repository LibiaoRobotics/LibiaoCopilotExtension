# Contributing Guide (贡献与开发指南)

欢迎参与 Libiao Copilot 的维护与二次开发！

在开始编写代码前，强烈建议先阅读我们的架构与避雷指南：
👉 **[Libiao Copilot 架构全景与开发者指南](docs/developer-handbook.md)**

---

## 快速上手

### 环境要求
- VS Code 1.120.0 或更高版本
- Node.js 20+
- 公司内部 NewAPI 网关地址与个人 API Key

### 调试与开发
```bash
git clone https://github.com/LibiaoRobotics/LibiaoCopilotExtension.git
cd LibiaoCopilotExtension
npm install
npm run compile
```
在 VS Code 中按 `F5` 启动调试窗口（Extension Development Host）。

### 常用命令
- 编译 TypeScript：`npm run compile`
- 监听编译：`npm run watch`
- 代码检查：`npm run lint`
- 自动化测试：`npm test`（等价于 `npm run compile && npx vscode-test`）
- 打包 VSIX：`npm run build`

---

## 核心避雷红线（必读）

1. **版本号变更**：`package.json` 中的 `version` 字段未经确认不得擅自变更。
2. **Git 提交与 Tag**：提交信息使用 Conventional Commits 规范（`feat:`, `fix:` 等 + 中文描述）；Tag 一律打注解标签（`git tag -a vX.Y.Z -m "..."`）。
3. **打包依赖**：`@microsoft/tiktokenizer` 为运行时依赖，打包严禁使用 `--no-dependencies`。
4. **测试验证**：提交前必须运行 `npm test` 确保全部用例通过。