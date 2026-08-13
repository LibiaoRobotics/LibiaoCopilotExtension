# 新接入模型参数目录（2026-08-05 采集，同日官方源二次核对）

> 用途：为 `libiao-copilot/package.json` 的 `libiaoCopilot.models.default` 补充新模型配置。
> 数据来源：各厂商官方文档直抓（Google AI for Developers 模型页/thinking 页、OpenAI developers.openai.com 模型页、阿里云百炼 help.aliyun.com、MiniMax platform.minimaxi.com/minimaxi.com、Microsoft Foundry Claude 模型表）。Anthropic 官网本地网络无法直连，Claude 参数以 Anthropic 官方发布稿转载 + Microsoft/Azure 官方模型表交叉验证。
> 采集日期：2026-08-05。模型参数会随版本更新，落地前建议以网关实测为准。
> 未写入 package.json，仅作为配置参考。

## 通用说明

- 配置格式对齐现有 `qwen3.8-max` 等条目结构。
- `context_sizes` / `default_context_size`：沿用现有三档 `[262144, 524288, 1000000]`、默认 `524288`。注意：VS Code 本身从不按 `contextSize` 裁剪历史，但自 2026-08-13 起扩展把它作为**输入侧预算**用于上下文管理（超预算先摘要、失败降级硬截断，可经 `libiaoCopilot.contextManagement` 关闭）；请求的输出上限仍由 `max_tokens` 决定。
- `owned_by`：默认 `libiaorobot`（全部走公司网关，地址见管理员下发的配置）。如需直连厂商官方 API，把 `owned_by` 设为厂商标识并补 `baseUrl`。
- `reasoning_efforts`：只对官方支持 effort 档位的模型（Gemini thinking level、GPT reasoning effort、Claude output_config effort）填写；仅支持 thinking 开关的模型（MiniMax/GLM/Qwen）不填。

---

## 一、汇总表

| 模型 ID | 上下文 | 最大输出 | 思考/effort | 视觉 | 参考价（输入/输出，每 1M token） |
|---|---|---|---|---|---|
| gemini-3.1-pro-preview | 1,048,576 | 65,536 | thinking：high(默认)，档位 low/medium/high | ✅ | $2/$12（≤200K），$4/$18（>200K） |
| gemini-3.1-flash-image（原 preview ID 已转正） | 131,072 | 32,768 | thinking 开关（on/off） | ✅（图像生成+理解） | 图像输出 $120/1M tokens |
| gemini-3.5-flash | 1,048,576 | 65,536 | thinking：medium(默认)，档位 minimal/low/medium/high | ✅ | $0.075/1M 输入（约，第三方） |
| gemini-3.6-flash | 1,048,576 | 65,536 | thinking：medium(默认)，档位 minimal/low/medium/high | ✅ | $1.50/$7.50 |
| gpt-5.6-luna | 1,050,000（输入上限 922,000） | 128,000 | reasoning：medium(默认)，档位含 xhigh/max | ✅ | $0.20/$1.20（官方现价） |
| gpt-5.6-sol | 1,050,000（输入上限 922,000） | 128,000 | reasoning：medium(默认)，档位含 xhigh/max | ✅ | $5/$30 |
| gpt-5.6-terra | 1,050,000（输入上限 922,000） | 128,000 | reasoning：medium(默认)，档位含 xhigh/max | ✅ | $2/$12（官方现价） |
| gpt-5.5 | 1,050,000（输入上限 922,000） | 128,000 | reasoning：medium(默认)，档位含 xhigh | ✅ | $5/$30 |
| claude-opus-4-8 | 1,000,000 | 128,000（Batches 可 300K） | effort：high(默认)/low/medium/xhigh/max | ✅ | $5/$25 |
| claude-opus-5 | 1,000,000 | 128,000（Batches 可 300K） | effort：high(默认)/low/medium/xhigh/max | ✅ | $5/$25 |
| claude-sonnet-5 | 1,000,000 | 128,000 | effort：high(默认)/low/medium/xhigh/max | ✅ | $2/$10（推广至 2026-08-31），后 $3/$15 |
| MiniMax-M3 | 1,000,000（保证 512K） | 官方未公布 | thinking 开关（interleaved thinking） | ✅（文本/图像/视频输入） | 见 Token Plan 订阅 |
| glm-5.2 | 1,048,576 | 131,072 | 思考模式（开关） | ❌（Text 输入） | ¥8/¥28 |
| qwen3.7-plus | 1,000,000（输入上限 991,808） | 131,072（中国区官方确认） | 思考模式（开关） | ✅（Text/Image/Video） | ¥2/¥8（≤256K），¥6/¥24（>256K） |
| qwen3.7-max | 1,000,000（输入上限 991,808） | 65,536 | 思考模式（开关） | ❌（标准版；6/8 快照支持视觉） | ¥12/¥36 |
| qwen3.8-max（-preview 为网关别名，参数同） | 1,000,000 | 65,536 | effort：xhigh(默认)，档位 low/medium/xhigh | ✅ | 未公布 |

---

## 二、逐模型详细配置

### 1. gemini-3.1-pro-preview（Google）

- 来源：Google AI for Developers 官方模型页（ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview，直抓核对）
- 规格：输入 1,048,576 / 输出 65,536；多模态（文本/图像/视频/音频/PDF → 文本）；thinking 官方默认 high，官方档位 low/medium/high（thinking 文档表）；另有 customtools 变体端点

```json
{
  "id": "gemini-3.1-pro-preview",
  "owned_by": "libiaorobot",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "reasoning_effort": "high",
  "reasoning_efforts": ["low", "medium", "high"],
  "vision": true
}
```

### 2. gemini-3.1-flash-image（Google，图像模型；原 ID gemini-3.1-flash-image-preview 已转正）

- 来源：Google AI for Developers 官方模型页（ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image，直抓核对）
- ⚠️ 官方模型清单中该模型当前 Stable ID 为 `gemini-3.1-flash-image`（Nano Banana 2），原 `-preview` 后缀已去掉。若网关仍用 preview ID 需确认兼容别名。
- 规格（官方实测表）：**输入上限 131,072 / 输出上限 32,768**（不是 1M/64K，此前版本按 flash 系推断是错的）；输入 Text/Image/PDF，输出 Image+Text；Thinking 支持（开关式）；输出分辨率 0.5K~4K；宽高比含 1:4/4:1/1:8/8:1

```json
{
  "id": "gemini-3.1-flash-image",
  "owned_by": "libiaorobot",
  "context_length": 131072,
  "context_sizes": [65536, 131072],
  "default_context_size": 131072,
  "max_tokens": 32768,
  "vision": true
}
```

### 3. gemini-3.5-flash（Google）

- 来源：Google AI for Developers 官方模型页（直抓核对）+ thinking 文档
- 规格（官方实测表）：**输入 1,048,576 / 输出 65,536**（此前写 1,000,000 不精确）；多模态输入（文本/图像/视频/音频/PDF）；Computer Use（Preview）；thinking 官方默认 **medium**（官方 thinking 表确认），官方档位 minimal/low/medium/high

```json
{
  "id": "gemini-3.5-flash",
  "owned_by": "libiaorobot",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high"],
  "vision": true
}
```

### 4. gemini-3.6-flash（Google）

- 来源：Google AI for Developers 官方模型页（直抓核对）+ thinking 文档
- 规格（官方实测表）：输入 1,048,576 / 输出 65,536；多模态输入（文本/图像/视频/音频/PDF）；Computer Use（Preview）；thinking 官方默认 **medium**（官方表确认），官方档位 minimal/low/medium/high

```json
{
  "id": "gemini-3.6-flash",
  "owned_by": "libiaorobot",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high"],
  "vision": true
}
```

> 注：Gemini 官方档位含 `minimal`，但插件 schema 枚举无 minimal，故 picker 只暴露 low/medium/high 三档。

### 5. gpt-5.6-luna（OpenAI）

- 来源：OpenAI 官方模型页（platform.openai.com/docs/models，直抓核对）
- 规格（官方页）：Context window 1.05M / Max output 128K；Reasoning 档位官方列出 none/low/medium/high/xhigh/max，默认 medium；知识截止 2026-02-16；文本+图像输入
- 价格（官方页现价）：$0.20 输入 / $1.20 输出（比 7/30 降价后的 $1/$6 又降了一轮）

```json
{
  "id": "gpt-5.6-luna",
  "owned_by": "libiaorobot",
  "context_length": 1050000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 6. gpt-5.6-sol（OpenAI）

- 来源：同上（官方模型页）；`gpt-5.6` 别名路由到 sol
- 规格（官方页）：与 Luna 相同窗口/输出；Reasoning 官方档位 none/low/medium/high/xhigh/max；$5/$30

```json
{
  "id": "gpt-5.6-sol",
  "owned_by": "libiaorobot",
  "context_length": 1050000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 7. gpt-5.6-terra（OpenAI）

- 来源：同上（官方模型页）
- 规格（官方页）：与 Sol/Luna 相同窗口/输出；Reasoning 官方档位 none/low/medium/high/xhigh/max；价格（官方页现价）：$2 输入 / $12 输出

```json
{
  "id": "gpt-5.6-terra",
  "owned_by": "libiaorobot",
  "context_length": 1050000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 8. gpt-5.5（OpenAI）

- 来源：OpenAI 官方模型详情页（developers.openai.com/api/docs/models/gpt-5.5，直抓核对）
- 规格（官方页）：1,050,000 context window / 128,000 max output；输入 text+image，输出 text；知识截止 2025-12-01；**Reasoning.effort 官方支持 none/low/medium(默认)/high/xhigh**；>272K 输入长上下文溢价（输入 2x、输出 1.5x）；$5/$30

```json
{
  "id": "gpt-5.5",
  "owned_by": "libiaorobot",
  "context_length": 1050000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "medium",
  "reasoning_efforts": ["low", "medium", "high", "xhigh"],
  "vision": true
}
```

### 9. claude-opus-4-8（Anthropic）

- 来源：Anthropic 官方发布（2026-05-28）；OpenRouter 模型页；简书官方口径核对
- 规格：1M 上下文 / 128K 最大输出（Message Batches API 加 `output-300k-2026-03-24` beta header 可到 300K）；effort 五档 low/medium/high(默认)/xhigh/max；thinking adaptive；文本/图像/文件输入；$5/$25

```json
{
  "id": "claude-opus-4-8",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "high",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 10. claude-opus-5（Anthropic）

- 来源：Anthropic 官方发布（2026-07-24）；开发者接入实测（2026-07-25）
- 规格：1M 上下文 / 128K 最大输出（Batches 300K）；thinking 默认开启；effort 五档（关闭 thinking 被限制在 high 及以下，disabled + xhigh/max 会报 400）；知识截止 2026-05；$5/$25

```json
{
  "id": "claude-opus-5",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "high",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 11. claude-sonnet-5（Anthropic）

- 来源：Anthropic 官方模型对比（2026-07）；开源社区汇总
- 规格：1M 上下文 / 128K 最大输出；effort 五档；$2/$10 推广价（2026-08-31 前），之后 $3/$15

```json
{
  "id": "claude-sonnet-5",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "reasoning_effort": "high",
  "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
  "vision": true
}
```

### 12. MiniMax-M3（MiniMax）

- 来源：MiniMax 官方模型页（minimaxi.com/models/text/m3，直抓）+ 开放平台文档（platform.minimaxi.com/docs/guides/text-generation，直抓）
- 规格（官方）：上下文 1,000,000（官方承诺至少 512K 可用）；原生多模态（OpenAI 兼容 Chat Completions 支持文本/图片/视频输入）；thinking 开关（Anthropic 兼容端点支持 thinking 块、interleaved thinking）；适用于 Agent 推理/工具调用/代码
- ⚠️ 最大输出官方两处文档均未公布；下方配置先用 65,536 保守值，落地前网关实测后可上调（第三方曾标 131K，不作数）

```json
{
  "id": "MiniMax-M3",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "vision": true
}
```

### 13. glm-5.2（智谱 Z.ai）

- 来源：阿里云百炼 ZHIPU/GLM-5.2 官方页（2026-07-31 更新）；智谱开源公告（2026-06-13，MIT 协议，744B/753B 参数）
- 规格：上下文 1,048,576 / 最大输入 1,048,576 / 最大输出 131,072；思考模式：最大输出（思考模式下）131,072、最大思维链 131,072；Text 输入/输出；Function Calling 支持；结构化输出支持；联网搜索不支持；¥8/¥28

```json
{
  "id": "glm-5.2",
  "owned_by": "libiaorobot",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 131072,
  "include_reasoning_in_request": true,
  "vision": false
}
```

### 14. qwen3.7-plus（阿里云千问）

- 来源：阿里云百炼中国区官方页（help.aliyun.com/zh/model-studio/qwen3-7-plus，直抓核对）
- 规格（官方）：上下文 1,000,000 / 最大输入 991,808 / 最大输出 131,072；思考模式下输入 983,616/输出 131,072、最大思维链 262,144；Image/Text/Video 输入、Text 输出；Function Calling/结构化输出/联网搜索/批量推理均支持；当前版本等同快照 qwen3.7-plus-2026-05-26
- ✅ 此前“社区文章称输出 32,768”的冲突已由中国区官方页排除，官方值就是 131,072；价格（华北 2 北京）：≤256K 输入 ¥2/¥8，>256K ¥6/¥24

```json
{
  "id": "qwen3.7-plus",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 131072,
  "include_reasoning_in_request": true,
  "vision": true
}
```

### 15. qwen3.7-max（阿里云千问）

- 来源：阿里云百炼 qwen3.7-max 官方页（2026-07-24 更新）
- 规格：上下文 1,000,000 / 最大输入 991,808 / 最大输出 65,536；思考模式下输入 983,616/输出 65,536、最大思维链 262,144；当前标准版 Text 输入/输出（qwen3.7-max-2026-06-08 快照起支持 Image/Video 输入）；Function Calling 支持；联网搜索支持；¥12/¥36

```json
{
  "id": "qwen3.7-max",
  "owned_by": "libiaorobot",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "include_reasoning_in_request": true,
  "vision": false
}
```

> 注：若网关实际挂载的是 `qwen3.7-max-2026-06-08` 及以后快照，`vision` 可改为 `true`。

### 16. qwen3.8-max（阿里云千问，-preview 为网关内部别名）

- 来源：阿里云百炼/Qwen 官方博客（2026-08 查证）
- 规格：上下文 1,000,000 / 最大输出 65,536；`reasoning_effort` 默认 xhigh，官方档位 low/medium/xhigh；官方支持图像输入（input_modalities 含 image）；`qwen3.8-max-preview` 为网关内部别名，参数与 `qwen3.8-max` 相同（package.json 两条并存）

```json
{
  "id": "qwen3.8-max",
  "owned_by": "libiaorobot",
  "apiMode": "openai",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 65536,
  "reasoning_effort": "xhigh",
  "reasoning_efforts": ["low", "medium", "xhigh"],
  "vision": true
}
```

---

## 三、核对结论与注意事项（落地前必读）

### 二次核对（官方源直抓）修正清单

| 项 | 原值 | 修正值 | 依据 |
|---|---|---|---|
| gemini-3.1-flash-image-preview 上下文/输出 | 1M/64K（推断） | **131,072 / 32,768** | Google 官方模型页实测表 |
| gemini-3.1-flash-image-preview 模型 ID | -preview 后缀 | **gemini-3.1-flash-image**（已转正 Stable） | Google 官方模型清单 |
| gemini-3.5-flash 上下文 | 1,000,000 | **1,048,576** | Google 官方模型页 |
| gemini-3.5/3.6-flash 默认 thinking | 推测 | **官方确认 medium** | Google thinking 文档表 |
| gemini-3.1-pro thinking 档位 | low/high | **low/medium/high** | Google thinking 文档表 |
| gpt-5.6 全系 reasoning 档位 | low/medium/high | **none/low/medium/high/xhigh/max**（默认 medium） | OpenAI 官方模型页 |
| gpt-5.5 reasoning 档位 | 未列 | **none/low/medium(默认)/high/xhigh** | OpenAI 官方模型详情页 |
| gpt-5.6-luna/terra 价格 | $1/$6、$2.5/$15 | **$0.20/$1.20、$2/$12**（官方页现价） | OpenAI 官方模型页 |
| qwen3.7-plus 输出 32,768 冲突 | 未解决 | **官方 131,072 确认**，32,768 排除 | 百炼中国区官方页 |
| MiniMax-M3 最大输出 | 第三方 131K | **官方未公布，配置降为保守 65,536** | MiniMax 官方两处文档无此值 |

### 仍未确定（需网关实测）

1. `MiniMax-M3` 最大输出：官方无此数据，先用 65,536。
2. `gemini-3.1-flash-image`：网关若仅认旧 preview ID，需确认别名映射。

### 其他注意

3. **Claude 三个模型的官方页本地网络无法直连**（platform.claude.com 连接被拒），其 1M/128K/effort 五档数据经 Anthropic 官方发布稿转载 + Microsoft Foundry 官方模型表交叉验证，置信度高但非一手直抓。
4. **Claude thinking 语义**：Opus 5 默认 thinking 开启，且 `disabled + xhigh/max` 会报 400。若网关做映射，注意别把 effort 和 thinking 开关配成矛盾组合。
5. **qwen3.7-max 的视觉**：标准版纯文本，2026-06-08 起快照支持视觉，按网关挂载版本决定 `vision`。
6. **价格仅供参考**：OpenAI 2026-07 以来两次调价，官方页现价为最新基准；网关成本以实际为准。
7. **`context_sizes` 三档为显示用途**（handoff 已验证 display-only），如需真实限制上下文需另行改请求逻辑。