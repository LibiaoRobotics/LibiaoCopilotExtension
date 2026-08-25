---
description: 多协议流式解析、思考通道分离、泄漏守卫与异构网关适配指示
applyTo: "src/{openai,anthropic,gemini,ollama}/**/*.ts"
---

# 多协议流式与思考流规范 (Streaming Protocols & Thinking)

## 1. OpenAI Responses (`src/openai/openaiResponsesApi.ts`)
- **通道分离**：思考文本由 `response.reasoning_text.delta` 接收，正文由 `output_text.delta` 接收。
- **输出权威收敛**：文本增量只累积不抢跑发射，收敛至 `output_item.done` 或 `[DONE]` 权威发射，防止网关污染 delta 造成内容 2× 双发。
- **服务端工具自愈**：自发调用的服务端工具（`file_search_call`, `web_search_call` 等）自动转换为同名客户端调用并返回不可用错误，引导模型自愈。
- **跨通道泄漏守卫 (`runLeakGuard`)**：在 reasoning 文本反引号失衡且正文开头出现孤儿 `</think>` 时，自动将泄漏思考转移至折叠区。

## 2. Anthropic (`src/anthropic/anthropicApi.ts`)
- **原生思考**：思考走 `thinking_delta`。检测到原生思考块（`_sawNativeThinkingBlock`）后，`text_delta` 直发正文，不进 XML 解析避免正文截断。
- **Usage 合并**：宽容合并 `message_start.usage` 与 `message_delta.usage`，确保 Token 统计完整。

## 3. Google Gemini (`src/gemini/geminiApi.ts`)
- **思考必要参数**：开启思考等级时**必须携带 `includeThoughts: true`**，否则 Google 服务端会静默扣留思考内容（Hidden Thinking）。
- **Schema 白名单过滤 (`stripUnsupportedGeminiSchemaKeys`)**：严格保留用户自定义 `properties` 参数名称，仅剔除未支持的 Draft 关键字。

## 4. 通用 XML 思考解析 (`src/commonApi.ts`)
- 支持 `<think>` 与 `<thinking>` 双标签；流收尾必须调用 `flushXmlThinkPending` 冲刷挂起缓冲。
- 门控条件 `(_hasEmittedAssistantText || _everBufferedThinking)` 确保正文字面量标签不误吞后续内容。
- 思考结束哨兵必须携带 `{ vscode_reasoning_done: true }` 元数据。
