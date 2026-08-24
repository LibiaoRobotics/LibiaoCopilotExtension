---
name: add-builtin-model
description: 新增、修改或维护 Libiao Copilot 官方内置模型条目的专业技能。当用户要求添加新模型（如 deepseek-v5、qwen3.9 等）、修改内置模型参数、更新 thinking 挡位、配置 priceNote 成本标注或维护 model-catalog 时使用。
---

# 新增与维护内置模型技能 (Add Built-in Model Skill)

本技能用于在 Libiao Copilot 插件中新增或修改内置模型（`package.json` `libiaoCopilot.models.default`），并同步更新规格文档、价格标注和测试用例。

---

## 🚨 核心避雷红线（违规必翻车）

1. **`displayName` 必须是纯文本，严禁手动写 Emoji**：
   - 视觉图标（👁️/🖼️）由 `src/provideModel.ts` 的 `formatModelDisplayName` 根据 `"vision": true` **全动态装配**。
   - **血泪教训**：若在 `displayName` 中手写 Emoji（如 `"👁️ DeepSeek V5"`），会导致 UI 渲染为 **`👁️ 👁️ DeepSeek V5`（双图标事故）**！
2. **禁止破坏 `package.json` 全局格式**：
   - **严禁**使用 `JSON.parse` + `JSON.stringify` 整体重写 `package.json`（会导致 1900+ 行 diff 爆炸、缩进错乱和单行数组被拆散）。
   - **必须**使用基于字符串的精确增量替换或 Node 脚本局部插入。
3. **apiMode 与思考字段严格匹配**（写错字段会导致思考静默失效）：
   - `openai-responses` 模式：**只能**写 `"reasoning_effort"` 和 `"reasoning_efforts": [...]`。**严禁**写 `enable_thinking` 或顶层 `thinking`！
   - `anthropic` 模式：**只能**写在 `"extra": { "thinking": { "type": "enabled", "budget_tokens": 32000 } }`。**严禁**写顶层 `thinking` 或 `reasoning_effort`！
   - `openai` 模式：写 `"thinking": { "type": "enabled" }`。
4. **禁止凭常理脑补，提交前必须 `curl` 真机验证**：
   - 必须向 NewAPI 网关发送真实请求，验证 HTTP 200、思考出字、以及 `effort` 是否被真实采纳。
   - **Vision 避坑**：测试图像理解时**严禁使用 1x1 假图**（部分模型有最小分辨率限制会报 HTTP 400），必须使用正常尺寸图片。

---

## 🛠️ 标准操作 SOP

### 第 1 步：确定模型参数与 apiMode 决策树
根据官方规范确定字段：
- `id` / `name` / `owned_by`
- `displayName`: **纯文本（不带 Emoji）**
- `context_length`（如 1000000）
- `context_sizes`: `[262144, 524288, 1000000]`，`default_context_size`: `524288`
- `max_tokens`（取思考模式下的最大输出，如 128000）
- `vision`: `true` / `false`
- `apiMode` 判定：
  - 官方支持 Responses API $\rightarrow$ `"openai-responses"`
  - 厂商原生 Anthropic 端点（如 GLM） $\rightarrow$ `"anthropic"`
  - 传统 Chat Completions $\rightarrow$ `"openai"`

---

### 第 2 步：向网关发送 `curl` 连通性与思考真机探测
网关地址：`https://newapi.libiaorobot.com/v1`

**Responses 模式探测模板（PowerShell）**：
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/responses" -H "Authorization: Bearer <Key>" -H "content-type: application/json" -d '{"model":"<模型id>","input":"1+1等于几？请一步步推理后只回答最终数字","max_output_tokens":256,"reasoning":{"effort":"high"}}'
```
* **判定标准**：
  - HTTP 200 且返回内容含思考流或 `reasoning_tokens > 0`；
  - 确认传入的 `effort` 被正常采纳。

---

### 第 3 步：配置 `priceNote` 成本/推荐标注
根据模型定位确定是推荐（`⭐推荐⭐`）还是不推荐（`❌不推荐❌`）：
1. 在 `libiao-copilot/scripts/set-price-notes.js` 中的 `assigns` 表登记该模型 ID。
2. 运行 `node scripts/set-price-notes.js` 或在插入条目时带上 `priceNote`：
   - 推荐：`"priceNote": "\u2B50\uFE0F推荐\u2B50\uFE0F"`
   - 不推荐：`"priceNote": "\u274C\uFE0F不推荐\u274C\uFE0F"`

---

### 第 4 步：安全写入 `package.json`
在 `libiao-copilot/package.json` 的 `libiaoCopilot.models.default` 数组中添加条目。
标准条目示例：
```json
{
  "id": "qwen3.8-max",
  "name": "Qwen 3.8 Max",
  "displayName": "Qwen 3.8 Max",
  "owned_by": "alibaba",
  "priceNote": "\u2B50\uFE0F推荐\u2B50\uFE0F",
  "context_length": 1000000,
  "context_sizes": [262144, 524288, 1000000],
  "default_context_size": 524288,
  "max_tokens": 128000,
  "apiMode": "openai-responses",
  "vision": true,
  "reasoning_effort": "xhigh",
  "reasoning_efforts": ["low", "medium", "xhigh"],
  "include_reasoning_in_request": true
}
```

---

### 第 5 步：同步更新模型规格文档
在 `libiao-copilot/docs/model-catalog.md` 与 `libiao-copilot/docs/developer-handbook.md` 中追加该模型的参数大表记录与关键发现。

---

### 第 6 步：执行测试回归验证
在 `libiao-copilot/` 目录下执行：
```powershell
npm run compile
npm test
```
确保 `modelConfiguration.test.ts`、元数据解析、以及全量测试全部 PASS！
