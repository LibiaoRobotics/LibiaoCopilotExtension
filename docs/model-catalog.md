# Libiao Copilot 官方内置模型规格目录与网关核验档案

> **用途**：作为 `libiao-copilot/package.json` 中 `libiaoCopilot.models.default` 21 款官方内置模型的权威技术档案库。
> **数据基准**：厂商官方一手文档直抓 + 公司 NewAPI 网关真机 `curl` 连通性与流式实测验证。
> **适用版本**：Libiao Copilot v1.0.8 / v1.0.9+。

---

## 📌 通用配置规范与机制说明

1. **上下文预算机制（Context Size）**：
   - 沿用标准三档 `[262144, 524288, 1000000]`（256K / 512K / 1M），默认 `524288`（512K）。
   - **核心语义**：VS Code 原生从不主动裁剪历史。自 2026-08-13 起，插件将用户在齿轮菜单选择的 `contextSize` 作为**输入侧预算**传给 `contextManager`（超 90% 预算自动触发智能摘要压缩或硬截断）。
2. **Thinking / Reasoning 配置映射铁律**：
   - `openai-responses` 模式：只读 `reasoning_effort` + `reasoning_efforts: [...]`，发送给网关的 `reasoning.effort`；**严禁**写 `enable_thinking`。
   - `anthropic` 模式：通过 `extra: { thinking: { type: "enabled", budget_tokens: 32000 } }` 透传给 Anthropic 原生端点；不读顶层 `thinking` 或 `reasoning_effort`。
   - `openai` 模式：写 `thinking: { type: "enabled" }`。
3. **视觉图标动态装配（Vision）**：
   - `displayName` 保持纯文本（无 Emoji），前缀图标（👁️/🖼️）由 `src/provideModel.ts` 根据 `"vision": true` 全动态生成。

---

## 一、21 款官方内置模型参数总览大表

| 模型 ID | 显示名称 | apiMode | 上下文窗口 | 最大输出 | 思考 / Effort 档位 (默认档) | 视觉 | 推荐状态 (priceNote) | 参考定价 (每 1M tokens) |
|---|---|---|---|---|---|---|---|---|
| `qwen3.8-max-preview` | Qwen 3.8 Max 预览版 | responses | 1,000,000 | 128,000 | low / medium / xhigh (**xhigh**) | ✅ | — | 官方未公布 |
| `qwen3.8-max` | Qwen 3.8 Max | responses | 1,000,000 | 128,000 | low / medium / xhigh (**xhigh**) | ✅ | ⭐推荐⭐ | 官方未公布 |
| `deepseek-v4-pro` | DeepSeek Pro | responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ❌ | ❌不推荐❌ | ¥2 / ¥8 |
| `deepseek-v4-flash` | DeepSeek Flash | responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ❌ | ⭐推荐⭐ | ¥0.1~0.3 / ¥0.5~1.0 |
| `deepseek-v4-flash-vision-exp` | 识图版Deepseek V4 Flash | responses | 1,000,000 | 384,000 | low / high / xhigh / max (**max**) | ✅ | ⭐推荐⭐ | ¥0.1~0.3 / ¥0.5~1.0 |
| `gpt-5.6-luna` | GPT 5.6 Luna | responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌不推荐❌ | $0.20 / $1.20 |
| `gpt-5.6-sol` | GPT 5.6 Sol | responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — | $5.00 / $30.00 |
| `gpt-5.6-terra` | GPT 5.6 Terra | responses | 1,050,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌不推荐❌ | $2.00 / $12.00 |
| `gpt-5.5` | GPT 5.5 | responses | 1,050,000 | 128,000 | low / medium / high / xhigh (**xhigh**) | ✅ | ❌不推荐❌ | $5.00 / $30.00 |
| `claude-opus-4-8` | Claude Opus 4.8 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | ❌不推荐❌ | $5.00 / $25.00 |
| `claude-opus-5` | Claude Opus 5 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — | $5.00 / $25.00 |
| `claude-sonnet-5` | Claude Sonnet 5 | openai | 1,000,000 | 128,000 | low / medium / high / xhigh / max (**medium**) | ✅ | — | $2.00 / $10.00 |
| `MiniMax-M3` | MiniMax M3 | openai | 1,000,000 | 65,536 | thinking 块（开关式） | ✅ | ❌不推荐❌ | 订阅制 Token Plan |
| `glm-5.2` | GLM-5.2 | anthropic | 1,048,576 | 131,072 | extra.thinking 开关 (32K budget) | ❌ | — | ¥8 / ¥28 |
| `glm-5.3` | GLM-5.3 | anthropic | 1,048,576 | 131,072 | 强制思考 (extra.thinking 32K budget) | ❌ | ⭐推荐⭐ | 官方积分制 |
| `qwen3.7-plus` | Qwen 3.7 Plus | responses | 1,000,000 | 131,072 | minimal / low / medium / high (**high**) | ✅ | — | ¥2 / ¥8 |
| `qwen3.7-max` | Qwen 3.7 Max | responses | 1,000,000 | 65,536 | minimal / low / medium / high (**high**) | ❌ | — | ¥12 / ¥36 |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro 预览版 | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | — | $2 / $12 |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | openai | 131,072 | 32,768 | thinking 开关 (默认 128K 预算) | ✅ | ❌不推荐❌ | 图像输出 $120/1M |
| `gemini-3.5-flash` | Gemini 3.5 Flash | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | ❌不推荐❌ | $0.075 / 1M 输入 |
| `gemini-3.6-flash` | Gemini 3.6 Flash | openai | 1,048,576 | 65,536 | low / medium / high (**high**) | ✅ | — | $1.50 / $7.50 |

---

## 二、网关实测核验与经典踩坑实录 (Gateway Checks & Traps)

### 1. Qwen 3.8 / 3.7 系列（阿里云百炼 Responses 原生端点）
- **实测验证**：向网关 `/v1/responses` 请求 `qwen3.8-max` 返回 HTTP 200，响应 ID 带 `resp_` 前缀和 `x_billing_type: response_api`，为百炼 Responses 原生格式。
- **输出口径差异**：官方文档口径写 65,536，但实测百炼网关支持输出到 128,000，配置按 128,000 录入。
- **思考字段陷阱**：Responses 路径下**只读 `reasoning.effort`**，传 `enable_thinking` 会被网关静默忽略。
- **Vision 避坑实录**：`qwen3.8-max` 图像理解能力在网关已全链路调通。早期曾遇到 HTTP 400，排查根因为测试脚本使用了 **1x1 像素的极小测试图**，触发了模型服务端的最小图像尺寸限制，更换为正常图片后完全正常。

### 2. DeepSeek V4 Pro / Flash（网关 Responses 中继）
- **实测验证**：向网关 `/v1/responses` 请求返回 HTTP 200，响应为标准 Responses 格式（`output` 包含 `reasoning` 与 `message` 两段），`reasoning.effort: max` 正常生效并回显。
- **Tool Calling 回传**：在工具调用多轮对话中，助手消息必须将 `reasoning_content` 完整回传，因此条目配置必须开启 `"include_reasoning_in_request": true`。
- **输出上限**：1M 上下文窗口下支持最大 384K 输出（为输入留出约 616K 空间）。

### 3. GLM-5.2 / GLM-5.3（智谱 Anthropic 原生链路）
- **打通历程**：
  - 早期走 `/v1/chat/completions` 为翻译层（网关把 Anthropic 转 OpenAI 格式）。
  - 2026-08-15 网关直连智谱 Anthropic 原生端点后，链路彻底打通：响应 ID 变为 `msg_` 前缀，思考内容以原生带 `signature` 的 `thinking` 块吐出。
- **Effort 档位陷阱**：GLM 的 Claude 兼容端点**静默忽略 `reasoning_effort`**，仅通过 `thinking.budget_tokens` 控制思考深度。因此条目配置不暴露 `reasoning_efforts` 菜单，统一通过 `extra.thinking.budget_tokens: 32000` 稳定控温。

### 4. Claude 系列（Opus 5 / Opus 4.8 / Sonnet 5）
- **Thinking 约束**：Claude Opus 5 默认开启思考；如果关闭思考模式，`reasoning_effort` 最高只能选到 `high`（若为 `disabled + xhigh/max` 网关会直接报错 HTTP 400）。

---

## 三、官方数据源与核查出处

- **DeepSeek Models & Thinking Guide**: https://api-docs.deepseek.com/guides/thinking_mode
- **Alibaba Model Studio (Qwen Text Models)**: https://help.aliyun.com/zh/model-studio/text-generation-model/
- **Qwen 3.8 Blog**: https://qwen.ai/blog?id=qwen3.8
- **OpenAI Developers Models Documentation**: https://platform.openai.com/docs/models
- **Google AI for Developers (Gemini API Models)**: https://ai.google.dev/gemini-api/docs/models
- **MiniMax Open Platform**: https://platform.minimaxi.com/docs/guides/text-generation
- **Zhipu AI BigModel Documentation**: https://docs.bigmodel.cn/
