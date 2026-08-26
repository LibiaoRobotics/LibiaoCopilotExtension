# 官方内置模型参数技术档案大表 (Built-in Models Catalog)

本文档归档 Libiao Copilot 官方内置模型的规格参数、推荐状态及网关配置细节，供 `add-builtin-model` 技能按需查阅。

---

## 📌 官方 22 款内置模型参数大表

| 模型 ID | 显示名称 | apiMode | 上下文窗口 | 最大输出 | 思考 / Effort 档位 (默认档) | 视觉 | 推荐状态 (priceNote) |
|---|---|---|---|---|---|---|---|
| `qwen3.8-max-preview` | Qwen 3.8 Max 预览版 | openai-responses | 1,000,000 | 128,000 | low / medium / xhigh (**xhigh**) | ✅ | — |
| `qwen3.8-max` | Qwen 3.8 Max | openai-responses | 1,000,000 | 128,000 | low / medium / xhigh (**xhigh**) | ✅ | ⭐️推荐⭐️ |
| `deepseek-v4-pro` | DeepSeek Pro | openai-responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ❌ | ❌️不推荐❌️ |
| `deepseek-v4-flash` | DeepSeek Flash | openai-responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ❌ | — |
| `deepseek-v4-flash-vision-exp` | Deepseek Flash 识图版 | openai-responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ✅ | ⭐️推荐⭐️ |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro 预览版 | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | — |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash | openai | 131,072 | 32,768 | — | ✅ | ❌️不推荐❌️ |
| `gemini-3.5-flash` | Gemini 3.5 Flash | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | ❌️不推荐❌️ |
| `gemini-3.6-flash` | Gemini 3.6 Flash | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | — |
| `gemini-3.7-flash` | Gemini 3.7 Flash | gemini | 1,048,576 | 65,536 | auto / low / medium / high (**auto**) | ✅ | ⭐️推荐⭐️快！太快了！比特哥前女友变心还快！ |
| `gpt-5.6-luna` | GPT-5.6 Luna | openai-responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌️不推荐❌️ |
| `gpt-5.6-sol` | GPT-5.6 Sol | openai-responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — |
| `gpt-5.6-terra` | GPT-5.6 Terra | openai-responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌️不推荐❌️ |
| `gpt-5.5` | GPT-5.5 | openai-responses | 1,050,000 | 128,000 | low / medium / high / xhigh (**xhigh**) | ✅ | ❌️不推荐❌️ |
| `claude-opus-4-8` | Claude Opus 4.8 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌️不推荐❌️ |
| `claude-opus-5` | Claude Opus 5 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — |
| `claude-sonnet-5` | Claude Sonnet 5 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — |
| `MiniMax-M3` | MiniMax M3 | openai | 1,000,000 | 65,536 | — | ✅ | ❌️不推荐❌️ |
| `glm-5.2` | GLM 5.2 | anthropic | 1,048,576 | 131,072 | extra.thinking (32K budget) | ❌ | ❌️不推荐❌️ |
| `glm-5.3` | GLM 5.3 | anthropic | 1,048,576 | 131,072 | extra.thinking (32K budget) | ❌ | ⭐️推荐⭐️ |
| `qwen3.7-plus` | Qwen 3.7 Plus | openai-responses | 1,000,000 | 131,072 | minimal / low / medium / high (**high**) | ✅ | ❌️不推荐❌️ |
| `qwen3.7-max` | Qwen 3.7 Max | openai-responses | 1,000,000 | 65,536 | minimal / low / medium / high (**high**) | ❌ | ❌️不推荐❌️ |

---

## 🔍 关键网关特性备忘

- **Qwen 3.8 / 3.7 系列**：走百炼 Responses 原生端点，只读 `reasoning.effort`；测试图像严禁使用 1x1 极小图防 400。
- **DeepSeek V4 Pro / Flash**：Responses 中继模式，多轮工具调用必须开启 `"include_reasoning_in_request": true`。
- **GLM-5.2 / GLM-5.3**：走 Anthropic 原生端点，通过 `extra.thinking.budget_tokens: 32000` 控温，不读 `reasoning_effort`。
- **Claude 系列**：Opus 5 默认思考；若关闭思考模式，`reasoning_effort` 仅支持到 `high`。
