---
description: Libiao Copilot 系统架构分层、模型发现合并机制与上下文管理指示
applyTo: "**/*.ts"
---

# 系统架构与核心机制指示 (Architecture & Core Mechanics)

## 1. 架构分层
- **入口**：`src/extension.ts`（注册模型提供者、设置命令及状态栏）。
- **总控分发**：`src/provider.ts`（实现 VS Code `LanguageModelChatProvider` 接口）。
- **协议适配层**：
  - `src/openai/`：OpenAI Chat Completions 与 OpenAI Responses 协议适配。
  - `src/anthropic/`：Anthropic Messages 协议原生适配与流式解析。
  - `src/gemini/`：Google Gemini 原生 REST/SSE 协议适配。
  - `src/ollama/`：Ollama 本地/远程模型协议适配。
- **提案 API（Proposed API）**：
  - `chatProvider`、`languageModelThinkingPart`、`languageModelSystem`、`languageModelDataPart`（类型见 `src/vscode.proposed.*.d.ts`）。

## 2. 模型合并发现机制 (`src/provideModel.ts`)
- **配置与探针合并**：`libiaoCopilot.models` 为元数据层，按 `apiMode|baseUrl` 分组探测各组真实 `/models` 列表。
- **严格可见性判定**：
  - 某组 API 探测失败（网络故障、URL 错误或 Key 无效）时，该组模型**全部隐藏，绝不以本地配置兜底**。
  - 若所有分组均探测失败，返回不可选占位条目 `__libiao-no-models__` 撑住 Copilot 供应商分区。
- **TTL 缓存机制**：
  - 缓存在 `fetchModelsCached`（键 `apiMode|baseUrl`），默认缓存 10 分钟。
  - 配置变更或执行 `libiaoCopilot.setApikey` 时强制清空缓存。

## 3. 上下文智能管理 (`src/contextManager.ts`)
- **预算上限**：$\lfloor \text{contextSize} \times 0.9 \rfloor$。
- **压缩决策**：历史消息窗口 $\le 1$ 条时不发起摘要（直接硬截断），避免浪费模型调用。
- **原子性保护 (`src/contextTrimmer.ts`)**：单个工具调用与对应结果必须成组保留或成组丢弃，严防孤儿消息。

## 4. UI 与状态栏
- **模型图标**：`displayName` 数据保持纯净，由 `formatModelDisplayName` 根据 `libiaoCopilot.visionIcon` 统一动态添加 `👁️` 或 `🖼️` 图标。
- **状态栏**：基于用户实际选定的 `contextSize` 比例计算，$\ge 90\%$ 报错，$\ge 70\%$ 告警。
