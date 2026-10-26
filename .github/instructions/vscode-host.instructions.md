---
description: VS Code 宿主语言模型机制（BYOK / Agent Host）、只读参考仓库与源码取证纪律
applyTo: "src/**/*.ts"
---

# VS Code 宿主机制与源码取证 (VS Code Host & Evidence)

## 1. 只读参考仓库
- `vscode-src/`（microsoft/vscode）、`vscode-docs/`（microsoft/vscode-docs）为**只读参考**：严禁修改其文件，严禁在其目录下运行构建命令。
- Copilot 插件源码位于 `vscode-src/extensions/copilot/`；原 `vscode-copilot-chat` 仓库已归档并移除，查最新实现一律看 `vscode-src/`。
- `vscode-src` 为 sparse-checkout（cone 模式）+ `blob:none` 部分克隆，当前检出路径：`extensions/copilot`、`src/vs/platform/agentHost`、`src/vs/workbench/api`、`src/vs/workbench/contrib/chat`、`src/vs/workbench/services`。
  - 需要其它路径（如 `src/vs/base`）时用 `git sparse-checkout add <path>` **增量补充**，不得重新 clone。
  - 缺文件只代表未检出，不代表仓库里没有；`git show` 老版本文件会按需联网下载，无网会失败。
- 更新方式：`git -C <repo> pull --ff-only`（两仓库默认分支均为 `main`，通常工作区干净）。

## 2. `isBYOK` 赋值规则（vscode 1.144.0 源码核实，2026-10-26）
`src/vs/workbench/api/browser/mainThreadLanguageModels.ts`：

```ts
if (m.metadata.isBYOK !== undefined) return m;   // provider 显式声明
const copilotExtensionId = productService.defaultChatAgent?.chatExtensionId;  // "GitHub.copilot-chat"
const isBuiltinCopilot = !!copilotExtensionId && ExtensionIdentifier.equals(m.metadata.extension, copilotExtensionId);
return { ...m, metadata: { ...m.metadata, isBYOK: !isBuiltinCopilot } };
```

- **任何非 `GitHub.copilot-chat` 扩展贡献的模型都会被自动标 `isBYOK: true`**；扩展无需也无法自行声明（`LanguageModelChatInformation` 里没有该字段）。
- 因此本项目的 `libiao-copilot` vendor 满足 BYOK 桥准入条件，可在 `agent-host-copilot` 会话中被列出并调用；各模型自己的 `apiMode` 仍由本项目代码处理，不因桥的统一 `responses` 协议而改变。

## 3. BYOK 桥链路
`agentHostByokLmHandler.listModels()` 枚举 `isBYOK && !targetChatSessionType` 的模型 → `synthesizeByokSessionConfig()` 按 vendor 合成 `type:'openai'` / `wireApi:'responses'` provider（baseUrl 指向本地回环代理 `/v/<vendor>/responses`）→ `byokLmProxyService` → 反向桥 `chat()` → `ILanguageModelsService.sendChatRequest` → 扩展真实 provider。

**闸门与限制**：`github.copilot.clientByokEnabled`（context key，默认 true）、`byokModelsEnabled`（`agentHostSchema.ts`，默认 true）、vendor 名不得含 `/`、工具数受 `BYOK_MAX_TOOLS` 上限约束（超出会被丢弃并记日志）、远程 Copilot 会话不支持 BYOK。

## 4. 取证纪律
- 涉及 VS Code 语言模型 / BYOK 行为时，必须**同时**检索 `out/vs/workbench/api/node/extensionHostProcess.js`（扩展宿主进程）与 `out/vs/workbench/workbench.desktop.main.js`（主进程 / 渲染侧）两个 bundle。
  - 只查前者会把「原样透传」误判为最终行为，因为 `isBYOK` 的实际判定发生在后者。
- 源码结论必须标注版本号与取证日期；与现场证据冲突时以现场证据为准，并同步修订本节。
