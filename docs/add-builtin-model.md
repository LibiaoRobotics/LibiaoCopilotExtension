# 如何新增一个内置模型条目（SOP）

> 读者：接手本项目的开发者，以及协助工作的 AI。
> 目标：新增一个内置模型条目（例如 glm-5.3），从调研到提交全流程零歧义。
> 本文所有规则均来自 2026-08 的实测与踩坑，案例带日期和证据，遇到与本文冲突的情况以实测为准并更新本文。

## 0. 开工前必读（3 个文件）

| 文件 | 作用 |
|---|---|
| `package.json` → `contributes.configuration` 里 `libiaoCopilot.models` 的 default 数组 | 内置条目的**唯一数据源**，现有 19 条就是活样例 |
| `docs/model-catalog.md` | 模型规格档案 + apiMode 核实表 + 关键发现（踩坑记录都在这里） |
| 本文档 | 操作流程 |

概念澄清：**内置条目**是打包进扩展的模型配置（package.json default 数组）。运行时它有两个用途：①用户配置了该模型时直接生效；②网关自动发现的模型若命中内置 id，以内置条目为权威元数据源（见 `src/provideModel.ts` 的 `toDiscoveredModelItem`）。

## 1. 第一步：调研模型规格（必须官方来源）

需要拿到以下数据，**只认官方文档/官方控制台页面**，社区文章只能作线索：

- [ ] 上下文窗口（context_length）
- [ ] 最大输出（max_tokens）——注意区分"普通模式"和"思考模式"下的值，取思考模式值（若存在）
- [ ] 输入模态（是否支持图像 → `vision` 字段）
- [ ] 思考机制类型（见第 3 节，这是最容易配错的地方）
- [ ] 官方支持的 API 协议（Chat Completions？Responses？Anthropic 兼容端点？）→ 决定 `apiMode`
- [ ] 价格（写入 catalog 备查）

官方数据有冲突时（常见：文档口径 vs 实测口径），以实测为准并在 catalog 注明两个口径（参考 qwen3.8-max 的 65536 vs 128000 案例，catalog 第 16 节）。

## 2. 第二步：确定 apiMode（决策树）

扩展支持五种 apiMode，请求路径和鉴权方式各不相同：

| apiMode | 请求端点 | 鉴权 | 适用 |
|---|---|---|---|
| `openai` | `{baseUrl}/chat/completions` | `Authorization: Bearer` | 只有 Chat Completions 的模型 |
| `openai-responses` | `{baseUrl}/responses` | `Authorization: Bearer` | 官方或网关确认支持 Responses 的模型 |
| `anthropic` | `{baseUrl}/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | 上游是原生 Anthropic 语义的模型 |
| `gemini` | Gemini 原生格式 | Bearer | Gemini 原生接入（走网关时一般不用） |
| `ollama` | Ollama 本地 | 无 | 本地模型 |

**决策树**（按顺序判断）：

1. 模型厂商**官方支持 Responses API**（如 qwen3.8 系、gpt-5.x 系）→ `openai-responses`
2. 厂商提供 **Anthropic 兼容端点**，且公司网关渠道已直连该原生端点（如 glm-5.2，2026-08-15 打通）→ `anthropic`
3. 其余（含 Gemini、MiniMax、官方无 Responses 的模型）→ `openai`

**关键原则：apiMode 必须实测验证，不接受口头确认。** 2026-08-13 的教训：deepseek 的 responses 支持先是"管理员口头确认"，后来才补了 curl 实测。验证方法见第 4 节。

## 3. 第三步：思考配置（最大雷区，逐模式对照）

⚠️ **不同 apiMode 读取的思考字段完全不同，写错字段思考会静默失效（不报错，只是不思考）。**

| apiMode | 思考字段 | 说明 |
|---|---|---|
| `openai` | `"thinking": {"type": "enabled"}` | 扩展 openai 路径读取此字段（GLM openai 模式、MiniMax 用这个） |
| `openai-responses` | `"reasoning_effort"` + `"reasoning_efforts"` | responses 路径只发 `reasoning.effort`。**绝对不要写 `enable_thinking`**——responses 路径不读它（2026-08-13 qwen3.7 两条因此返工，见 catalog 关键发现 4） |
| `anthropic` | `"extra": {"thinking": {"type": "enabled", "budget_tokens": N}}` | **绝对不要写顶层 `thinking`**（anthropic 路径不读）；**不要写 `reasoning_effort`**（同样不读）。`enabled` 必须带 `budget_tokens`，建议 32000 或按官方最大思维链设 |

`reasoning_effort` 合法枚举：`max` / `xhigh` / `high` / `medium` / `low` / `minimal`（package.json schema 定义）。`reasoning_efforts` 数组决定 UI 选择器展示哪些档位，省略则展示全部。

**effort 档位取值规则**：取「官方文档支持的档位」与「扩展枚举」的交集，默认值按项目当前策略定（2026-08 策略：成本敏感模型 medium，旗舰模型官方最高档，见 catalog 关键发现 7）。注意官方档位表可能没有 xhigh/max——qwen3.8 的 xhigh 是实测网关接受才保留的，没实测过就用官方文档里的档位。

其他固定字段：
- `"include_reasoning_in_request": true`——思考的模型都加上（anthropic 路径下用于把思考内容以 thinking block 回传多轮对话）
- `"vision"`——按官方模态如实填，别猜

## 4. 第四步：curl 实测（提交前必做）

### 4.1 网关连通性模板

网关地址：`https://newapi.libiaorobot.com/v1`。按 apiMode 选模板：

**openai**（PowerShell）：
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/chat/completions" -H "Authorization: Bearer <网关key>" -H "content-type: application/json" -d '{"model":"<模型id>","max_tokens":128,"messages":[{"role":"user","content":"1+1等于几？只回答数字"}]}'
```

**openai-responses**（第二发加 `"reasoning":{"effort":"<默认档>"}` 验证 effort 生效）：
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/responses" -H "Authorization: Bearer <网关key>" -H "content-type: application/json" -d '{"model":"<模型id>","input":"1+1等于几？只回答数字","max_output_tokens":128}'
```

**anthropic**（第二发加 cache_control 验证缓存链路）：
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/messages" -H "x-api-key: <网关key>" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"<模型id>","max_tokens":256,"thinking":{"type":"enabled","budget_tokens":32000},"messages":[{"role":"user","content":"1+1等于几？只回答数字"}]}'
```

### 4.2 判定标准

- HTTP 200 → 连通；401 → key/渠道问题；404 → 端点不支持该协议；429 code 1113 → 智谱账户余额不足（key 本身有效）
- 思考生效：响应里能看到思考内容或 `reasoning_tokens > 0`
- effort 生效：响应回显了你传的 effort 值

### 4.3 翻译层判别（anthropic / responses 模式必查）

网关可能对协议做翻译中继，判断上游是不是原生：

| 痕迹 | 含义 |
|---|---|
| 响应 `id` 前缀 `chatcmpl-` | ❌ 翻译层（上游返回的是 OpenAI 格式） |
| 响应 `id` 前缀 `msg_`（anthropic）或 `resp_`（responses） | ✅ 原生 |
| `billing_usage.source: "oai_chat"` | ❌ 翻译层自证（网关记账字段） |
| usage 里出现 `completion_tokens_details` 等 OpenAI 字段 | ❌ OpenAI 上游痕迹 |
| 原生 Anthropic 错误格式：`{"type":"error","error":{"type":...},"request_id":...}` | ✅ 原生 |

发现是翻译层时：报告给负责人决策（接受翻译层 or 修网关渠道配置），并在 catalog 记录证据。2026-08-15 glm 案例：初测 `chatcmpl-` + `oai_chat` → 修渠道后复测变 `msg_` 前缀、痕迹消失 → 判定打通原生。

## 5. 第五步：写条目 + 同步（4 个落点，一个都不能漏）

### 5.1 package.json 条目

插入 `libiaoCopilot.models` default 数组的合适位置（同厂商条目放一起）。模板（anthropic + 思考示例，其他模式按第 3 节替换思考字段）：

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

字段说明：
- `owned_by`：公司网关模型统一填 `"libiaorobot"`
- `context_sizes`：UI 上下文选择器档位，按官方支持值填，最大档 = context_length 附近的官方档位
- `default_context_size`：一般取中间档（现有条目多为 524288）
- 缩进用 **Tab**（eslint 强制），改完跑 `npm run compile` 或用编辑器确认 JSON 无语法错误

### 5.2 docs/model-catalog.md（3 处）

1. **模型详情章节**：新增一节（编号顺延），含来源、规格、价格、完整 JSON 示例
2. **apiMode 核实表**（第四节）：新增一行，"处置"列写 `已改 xxx（日期）`
3. **关键发现**：实测中的任何非常规发现（翻译层、档位冲突、文档口径差异）都要记一条，带日期和证据

### 5.3 scripts/oaicopilot-model-overrides.json（按需）

仅当**网关自动发现返回的规格欠报**（如 context/max_tokens 比官方小）时才加。格式见该文件现有条目。网关规格准确就不用动。

### 5.4 提交

commit message 风格对齐历史（`git log --oneline` 看样例），中文描述 + 关键决策理由。提交前确认 `npm run compile` 通过。

## 6. 踩坑备忘（全部真实案例）

| 日期 | 坑 | 教训 |
|---|---|---|
| 2026-08-13 | qwen3.7 两条在 responses 模式下写了 `enable_thinking: true`，思考静默失效 | responses 路径只读 `reasoning.effort`，见第 3 节对照表 |
| 2026-08-13 | glm 切 anthropic 后保留 openai 风格 `thinking` 字段，思考静默失效 | anthropic 模式必须用 `extra.thinking` 透传 |
| 2026-08-13 | deepseek responses 只有管理员口头确认，未实测 | 协议支持必须 curl 实测，见第 4 节 |
| 2026-08-15 | glm anthropic 初测是翻译层（`chatcmpl-` 前缀），网关渠道修复后才变原生 | 网关链路会变，结论带日期；复测优先于引用旧结论 |
| 2026-08-15 | cache_control 测试用 61 tokens 提示词，`cache_creation_input_tokens: 0`，差点误判"不支持缓存" | Anthropic 缓存有最小阈值（约 1024 tokens），测缓存要用长提示词 |
| 2026-08-15 | 用网关 key 直连智谱官方端点 401 | 网关 key 与厂商平台 key 是两套体系，互不通用 |

## 7. 完成清单（逐项打勾再交付）

- [ ] 官方规格已核实（来源链接记入 catalog）
- [ ] apiMode 按决策树确定，且 curl 实测通过（HTTP 200）
- [ ] 思考字段与 apiMode 匹配（对照第 3 节表格）
- [ ] effort 档位有依据（官方文档或实测）
- [ ] 翻译层判别已做（anthropic/responses 模式）
- [ ] package.json 条目已加，JSON 语法无误，`npm run compile` 通过
- [ ] model-catalog.md 三处同步（详情章节、核实表、关键发现）
- [ ] overrides.json 按需更新
- [ ] 提交，message 说明决策理由
