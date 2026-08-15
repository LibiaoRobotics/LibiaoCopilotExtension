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
| glm-5.3 | 1,048,576 | 131,072 | 强制思考；官方 effort：max(默认)/high/low（仅 Chat Completions 口径，Claude 端点不读） | ❌（Text 输入） | 未公布（官方 API 暂未上线，Coding Plan 积分制） |
| qwen3.7-plus | 1,000,000（输入上限 991,808） | 131,072（中国区官方确认） | 思考模式（开关） | ✅（Text/Image/Video） | ¥2/¥8（≤256K），¥6/¥24（>256K） |
| qwen3.7-max | 1,000,000（输入上限 991,808） | 65,536 | 思考模式（开关） | ❌（标准版；6/8 快照支持视觉） | ¥12/¥36 |
| qwen3.8-max（-preview 为网关别名，参数同） | 1,000,000 | 128,000 | effort：xhigh(默认)，档位 low/medium/xhigh | ✅ | 未公布 |

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
  "apiMode": "anthropic",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 131072,
  "extra": {
    "thinking": {
      "type": "enabled",
      "budget_tokens": 32000
    }
  },
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

### 17. glm-5.3（智谱 Z.ai）

- 来源：智谱官方文档 docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md（2026-08-15 直抓核对）+ 网关实测
- 规格：上下文 1,048,576 / 最大输出 131,072（官方口径 128K）；**仅文本模态**（无视觉）；**强制启用思考**，不支持 `thinking.type: disabled`（传 disabled 请求直接报错）；官方 `reasoning_effort` 档位 `low/high/max`、默认 `max`（仅 Chat Completions 口径，Claude 端点不读，见关键发现 9）；Function Calling/上下文缓存/结构化输出支持；模型 API 暂未全量上线（Coding Plan 已全量），价格官方未公布

```json
{
  "id": "glm-5.3",
  "owned_by": "libiaorobot",
  "apiMode": "anthropic",
  "context_length": 1048576,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 131072,
  "extra": {
    "thinking": {
      "type": "enabled",
      "budget_tokens": 32000
    }
  },
  "include_reasoning_in_request": true,
  "vision": false
}
```

### 16. qwen3.8-max（阿里云千问，-preview 为网关内部别名）

- 来源：阿里云百炼/Qwen 官方博客（2026-08 查证）
- 规格：上下文 1,000,000 / 最大输出 128,000（官方文档口径 65,536，2026-08-13 实测确认 128,000，配置按 128,000）；`reasoning_effort` 默认 xhigh，官方档位 low/medium/xhigh；官方支持图像输入（input_modalities 含 image）；`qwen3.8-max-preview` 为网关内部别名，参数与 `qwen3.8-max` 相同（package.json 两条并存）

```json
{
  "id": "qwen3.8-max",
  "owned_by": "libiaorobot",
  "apiMode": "openai",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
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

---

## 四、apiMode 官网核实（2026-08-13）

> 对 `package.json` 中 `libiaoCopilot.models.default` 全部 19 个内置模型的 `apiMode` 逐一核对官方口径（厂商官方文档直抓）。
> **重要前提：官网口径 ≠ 网关实际能力。** 所有模型实际走公司 new-api 网关（`owned_by: libiaorobot`），本表只回答「官方支持什么」，最终以网关路由为准。

| 模型 ID | package.json 当前 apiMode | 官网核实口径 | 官方 Responses API | 建议 |
|---|---|---|---|---|
| qwen3.8-max-preview | openai-responses | Chat Completions | ✅（百炼 compatible-mode，仅 Token Plan） | 已改 openai-responses（2026-08-13） |
| qwen3.8-max | openai-responses | Chat Completions | ✅ | 已改 openai-responses（2026-08-13） |
| deepseek-v4-pro | openai-responses | Chat Completions + Anthropic 格式 | ❌ 官方无此 API（responses 页 404） | **保持 openai-responses**：网关已确认支持（2026-08-13） |
| deepseek-v4-flash | openai-responses | 同上 | ❌ 同上 | 同上 |
| gemini-3.1-pro-preview | openai | OpenAI 兼容仅 Chat Completions | ❌ | 保持 |
| gemini-3.1-flash-image | openai | 同上 | ❌ | 保持 |
| gemini-3.5-flash | openai | 同上 | ❌ | 保持 |
| gemini-3.6-flash | openai | 同上 | ❌ | 保持 |
| gpt-5.6-luna | openai-responses | Chat Completions | ✅ 官方双支持（Endpoints 表） | 已改 openai-responses（2026-08-13） |
| gpt-5.6-sol | openai-responses | Chat Completions | ✅ 官方双支持 | 已改 openai-responses（2026-08-13） |
| gpt-5.6-terra | openai-responses | Chat Completions | ✅ 官方双支持 | 已改 openai-responses（2026-08-13） |
| gpt-5.5 | openai-responses | Chat Completions | ✅ 官方双支持 | 已改 openai-responses（2026-08-13） |
| claude-opus-4-8 | openai | 原生 Messages + Chat Completions 兼容 | ⚠️ 官方无据（第三方 OpenRouter 有 responses 中继） | 保持 openai |
| claude-opus-5 | openai | 同上 | ⚠️ 同上 | 保持 openai |
| claude-sonnet-5 | openai | 同上 | ⚠️ 同上 | 保持 openai |
| MiniMax-M3 | openai | Anthropic Messages（推荐）+ Chat Completions | ❌ | 保持 |
| glm-5.2 | anthropic | Chat Completions + Claude 兼容 | ❌ | 已改 anthropic（2026-08-15 打通原生链路，见关键发现 8） |
| glm-5.3 | anthropic | Chat Completions + Claude 兼容 + Response（官方文档列出，但注明「模型 API 将于近期上线」） | ❌（网关实测 500 `not implemented (convert_request_failed)`，2026-08-15） | anthropic：网关 `/v1/messages` 原生链路实测通过（见关键发现 9） |
| qwen3.7-plus | openai-responses | Chat Completions | ✅ | 已改 openai-responses（2026-08-13） |
| qwen3.7-max | openai-responses | Chat Completions | ✅ | 已改 openai-responses（2026-08-13） |

### 关键发现

1. **deepseek-v4-pro / flash 的 `openai-responses` 非官方能力，但网关已确认可用**：DeepSeek 官方仅开放 `/chat/completions`（OpenAI 格式）与 `/anthropic`（Claude 格式），responses 文档页 404。当前两条目标 `openai-responses` 依赖公司 new-api 网关的中继，**2026-08-13 管理员确认支持 + 同日 curl 实测通过，保持现状**：`/v1/responses` 对 deepseek-v4-pro 返回 HTTP 200，标准 Responses 语义（`object: response`、`output` 数组含 `reasoning` + `message` 两段），`reasoning.effort: max` 被接受并回显，思考正常输出（reasoning_tokens 可见）；唯一痕迹是响应 `id` 为裸 uuid（无 `resp_` 前缀），说明是中继实现而非原生 Responses。若未来改走官方直连，需改回 `openai`（或 `anthropic`）。
2. **qwen 系四条官方支持 Responses**（阿里云百炼 `compatible-mode/v1/responses`，支持模型清单明确含 qwen3.8-max、qwen3.8-max-preview、qwen3.7-max、qwen3.7-plus；文档 2026-08-03 更新）。**已于 2026-08-13 切换为 `openai-responses`**。**同日 curl 实测通过**：`/v1/responses` 对 qwen3.8-max 返回 HTTP 200，响应 `id` 为 `resp_` 前缀、带 `x_details`（`x_billing_type: response_api`），为百炼兼容端点原生格式；内置默认档 `reasoning.effort: xhigh` 被接受并回显，思考正常（原担心百炼文档档位表无 xhigh，实测网关认）。注意：旧路径 `/api/v2/apps/protocols/compatible-mode/v1/responses` 将弃用，用新路径；官方提示 `reasoning.effort` 优先于 `enable_thinking`，后者将弃用。
3. **gpt-5.6 全系 + gpt-5.5 官方双支持**（OpenAI 官方模型页 Endpoints 表：Chat Completions 与 Responses 均 Supported）。**已于 2026-08-13 切换为 `openai-responses`**。
4. ⚠️ **qwen3.7-plus / qwen3.7-max 的 `enable_thinking` 在 responses 路径下不生效**：扩展 `openaiResponsesApi` 只发送 `reasoning.effort`，不发送 `enable_thinking`。**已于 2026-08-13 处理**：两条内置条目移除 `enable_thinking: true`，改配 `reasoning_effort` + `reasoning_efforts: ["minimal", "low", "medium", "high"]`（默认 effort 当天随“默认思考等级全部调至最高档”一并设为 `high`，见第 7 条）。取值依据：百炼官方 Responses 文档 effort 档位为 none/minimal/low/medium(默认)/high（2026-08-03 更新，官方示例即 medium），与扩展枚举（minimal/low/medium/high/xhigh/max，无 none）取交集得 minimal/low/medium/high，最高档为 high。
5. **Claude 三兄弟官方无 Responses 证据**：Anthropic 官网（platform.claude.com / docs.claude.com）本地网络不可直连，Anthropic 官方 GitHub 与 Azure 官方文档亦无官方 Responses 兼容记录；原生为 Messages API，OpenAI SDK 兼容层覆盖 Chat Completions。权威第三方 OpenRouter 为 Claude 提供了 `/v1/responses` 中继，但那是 OpenRouter 的能力，非 Anthropic 官方。标 `openai` 正确。
6. **Gemini / MiniMax 官方无 Responses**，`openai` 模式正确；GLM 亦无 Responses，glm-5.2 走 `anthropic` 见关键发现第 8 条。
7. **2026-08-13：内置条目默认思考等级调整**：先统一调至官方最高档，后因成本与首字延迟考量，经确认将以下 6 条回调为 medium：gpt-5.6-luna / gpt-5.6-sol / gpt-5.6-terra（max → medium）、claude-opus-4-8 / claude-opus-5 / claude-sonnet-5（max → medium，注：Claude 三条调最高前原始默认是 high，本次回调后比原始默认还低一档）。保持最高档未动的：gpt-5.5 xhigh（官方无 max 档）、gemini-3.5-flash / gemini-3.6-flash high、qwen3.7-plus / qwen3.7-max high、qwen3.8-max(-preview) xhigh、deepseek-v4-pro/flash max、gemini-3.1-pro-preview high。开关式思考无等级档位未动：gemini-3.1-flash-image、MiniMax-M3、glm-5.2（thinking 已 enabled）。⚠️ 提醒：Claude 官方限制关闭 thinking 时 effort 最高只能到 high（disabled + xhigh/max 会报 400）；如需更高质量输出，可在设置 UI 中逐模型上调档位。本文档上方 JSON 示例块中的 `reasoning_effort` 仍为旧默认值，仅作结构参考。
9. **glm-5.3 接入决策（2026-08-15）：anthropic 模式 + 强制思考 + 官方 Responses 协议尚不可用**。①官方文档（glm-5.3 页）列出三个端点：OpenAI Chat Completion / OpenAI Response（`/api/v1`）/ Anthropic Message（`/api/anthropic`），但明确注明「模型 API 将于近期上线」——Responses 端点官方尚未开放。②网关实测：`/v1/messages` HTTP 200 且为**原生 Anthropic 链路**（`msg_` 前缀、原生 thinking block 带 `signature`、usage 为 Anthropic 原生结构、无 `billing_usage` 痕迹）；`/v1/responses` 返回 `500 not implemented (convert_request_failed)`（极简 body 复测为 `{"code":500,"msg":"404 NOT_FOUND"}`，网关未配置渠道）；`/v1/chat/completions` HTTP 200 但是**翻译层**（`billing_usage.source: claude_messages`，上游 Anthropic 翻成 OpenAI 格式）。③**effort 档位陷阱**：官方 `reasoning_effort`（low/high/max）仅 Chat Completions 口径有效；Claude 兼容端点实测**静默忽略**该字段（同题 low vs max：thinking 长度 2297 vs 2313 字符，无差异），实际控制思考深度的是 `thinking.budget_tokens`（budget 2000 vs 60000：output_tokens 821 vs 1044，封顶生效）。因此条目**不配 `reasoning_effort`**——anthropic 路径不读该字段，配了只会让 UI 出现选择器却完全不生效，误导用户；采用 `extra.thinking` + `budget_tokens: 32000`（与 glm-5.2 同策略）。④GLM-5.3 强制思考（`thinking.type: disabled` 会报错），无需考虑 disabled 组合。待办：官方 Responses API 上线且网关配通渠道后复测，届时可评估切换 `openai-responses`（切换时 effort 档位取 low/high/max，默认 max——官方旗舰模型策略）。
8. **glm-5.2 的 anthropic 链路（2026-08-13 回退 → 2026-08-15 二次切换 → 当日打通原生）**：历程：①2026-08-13 初切 anthropic 实测网关为翻译层（响应 `id` 前缀 `chatcmpl-`、`billing_usage.source: oai_chat`、`semantic: openai`，网关内部把 Anthropic 请求翻成 OpenAI 发给 GLM），遂回退 `openai`；②2026-08-15 二次切回 `anthropic`，初测仍是翻译层；③同日特哥调整网关渠道配置（渠道类型 Anthropic + 官方 base_url + 智谱 key）后复测，**翻译层消失，链路打通原生**：响应 `id` 前缀变为 `msg_`、`billing_usage` 痕迹全部消失、思考以原生 `thinking` block（带 `signature` 字段）输出、usage 为 Anthropic 原生结构。配置采用 `extra.thinking` 透传 Anthropic 原生格式。备忘：①openai 风格 `thinking: {type: "enabled"}` 在 anthropic 模式下不被扩展读取，必须用 `extra.thinking`（Anthropic 原生格式，enabled 必带 `budget_tokens`）透传；②cache_control 测试中 `cache_creation_input_tokens` 仍为 0，但测试提示词仅 61 tokens，低于 Anthropic 缓存最小阈值（约 1024 tokens），不能据此断定原生端不支持缓存，长提示词场景待复测；③anthropic 模式不读 `reasoning_effort`；④直连验证：智谱官方 key 对 `https://open.bigmodel.cn/api/anthropic/v1/messages` 初测 429（code 1113 余额不足，错误结构为原生 Anthropic 格式），网关 key 直连 401，确认两套 key 体系互不通用；打通原生后网关渠道使用的是智谱平台 key。

### 核实来源（2026-08-13）

- **OpenAI**：developers.openai.com 各模型页 Endpoints 表（gpt-5.6-luna / sol / terra、gpt-5.5）
- **DeepSeek**：api-docs.deepseek.com（chat/completions、anthropic；responses 页 404）
- **Google**：ai.google.dev/gemini-api/docs/openai（2026-06-22 更新）
- **阿里云**：alibabacloud.com/help/en/model-studio/compatibility-with-openai-responses-api（2026-08-03 更新）
- **MiniMax**：platform.minimaxi.com/docs/guides/text-generation
- **智谱**：docs.bigmodel.cn（GLM-5 页 + llms.txt 索引）
- **Anthropic**：官网不可直连；以官方发布稿 + Microsoft Foundry 官方模型表交叉验证 + OpenRouter 模型页（第三方权威源）为准