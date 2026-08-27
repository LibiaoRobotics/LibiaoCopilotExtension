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
3. **apiMode 与思考字段严格匹配**（写错字段会导致思考静默失效或 UI 无档位）：
   - `openai-responses` 模式：**必须**写 `"reasoning_effort"` 和 `"reasoning_efforts": [...]`。**严禁**写 `enable_thinking` 或顶层 `thinking`！
   - `anthropic` 模式：**只能**写在 `"extra": { "thinking": { "type": "enabled", "budget_tokens": 32000 } }`。**严禁**写顶层 `thinking` 或 `reasoning_effort`！
   - `gemini` 模式：写 `"reasoning_effort": "auto"` 与 `"reasoning_efforts": ["auto", "low", "medium", "high"]`（插件会自动携带 `includeThoughts: true`）。
   - `openai` 模式：若支持思考档位，配置 `"reasoning_effort"` 与 `"reasoning_efforts"`（供 VS Code 生成档位选择器）。
4. **思考档位必须严格限定在 7 档标准枚举白名单**：
   - 源码 `src/modelConfiguration.ts` 仅支持：`["auto", "minimal", "low", "medium", "high", "xhigh", "max"]`。
   - **血泪教训**：严禁自造非标档位（如 `off` / `none` / `medium_low`），否则 `isReasoningEffortValue` 校验失败会导致 VS Code 齿轮设置**静默隐藏档位选择器**！
5. **`include_reasoning_in_request` 开启边界铁律**：
   - **DeepSeek 系列**（V4 Pro/Flash）：多轮工具调用**必须配置 `"include_reasoning_in_request": true`**，否则网关会报上下文缺失。
   - **其他所有模型**（Qwen / GPT / Claude 等）：**严禁开启**（直接省略），否则部分网关识别到非法历史 reasoning 结构体会直接报 HTTP 400。
6. **模型规格三级权威溯源铁律（严禁无据脑补）**：
   - **一级（必须优先）**：必须查阅官方网站获取第一手厂商技术文档（如 OpenAI、Anthropic、Google DeepMind、阿里云百炼、DeepSeek 等）。
   - **二级（官方缺失降级）**：若厂商官网尚未收录或缺失，必须从权威第三方网站（如 HuggingFace 官方模型卡片、OpenRouter 官方模型目录）交叉查验。
   - **三级（熔断中断）**：若依然获取不到确切参数，**严禁凭常理脑补猜测，必须立即中断任务并提醒特哥决策**！
7. **提交前必须 `curl` 真机验证**：
   - 必须向 NewAPI 网关发送真实请求，验证 HTTP 200、思考出字、以及 `effort` 是否被真实采纳。
   - **Vision 避坑**：测试图像理解时**严禁使用 1x1 假图**（部分模型有最小分辨率限制会报 HTTP 400），必须使用正常尺寸图片。

---

## 🛠️ 标准操作 SOP（6 步极简骨架）

### 第 1 步：环境就绪 —— 检查并初始化 `NEWAPI_KEY`
在 PowerShell 中执行前置检查指令（无值时通过无痕掩码提示输入，变量名定死为 `NEWAPI_KEY`）：
```powershell
if (-not $env:NEWAPI_KEY) {
    $env:NEWAPI_KEY = Read-Host -MaskInput "请输入 NewAPI Key（当前会话有效，星号掩码）"
}
```

### 第 2 步：权威溯源、参数确定与 apiMode 决策
- 遵循三级溯源机制查验物理参数；
- 确保 `context_sizes` 升序且 $\min(\text{context\_sizes}) > \text{max\_tokens}$；
- 详细字段规范与四级决策树请参阅：
  👉 **[模型参数与 apiMode 决策矩阵 (Decision Matrix)](./decision-matrix.md)**

### 第 3 步：向网关发送 `curl` 连通性、思考流与 Vision 真机探测
- 使用 `$env:NEWAPI_KEY` 向 NewAPI 网关发送对应协议探测；
- 严格核验 HTTP 200、思考真实出字及档位极值；
- 各协议探测命令模板与三重验收标准请参阅：
  👉 **[网关真机探测与验收标准 (Gateway Probes)](./gateway-probes.md)**

### 第 4 步：确定 `priceNote` 推荐标注与 Unicode 转义
- 推荐款：`"priceNote": "\u2B50\uFE0F推荐\u2B50\uFE0F"`（支持追加个性化文案）；
- 不推荐款：`"priceNote": "\u274C\uFE0F不推荐\u274C\uFE0F"`；
- 普通/中立款：直接省略该字段；
- 纯文字备注形态（如 `"priceNote": "白菜价"`）：允许直接写纯文字，门禁仅要求无 U+FFFD 乱码；但**严禁**以 ⭐/❌ Emoji 开头却丢失变体选择符（`\uFE0F`）；
- **铁律**：严禁在 JSON 中手写字面 Emoji，必须使用 Unicode 转义符防乱码。

### 第 5 步：安全写入 `package.json` 并执行全量自检门禁
1. **聚合插入**：将新条目增量插入到 `package.json` 所属厂商家族内部（主推款置顶）。
2. **一键自检**：在 `libiao-copilot/` 目录下执行全量内置模型自检门禁：
   ```powershell
   npm run verify:models
   ```
   （自动校验 ID 查重、Emoji 码点完整性、7 档枚举白名单与预算截断防护，一票否决）。

### 第 6 步：执行全量测试回归与档案大表同步
1. **自动化全量回归**：在 `libiao-copilot/` 目录下执行：
   ```powershell
   npm test
   ```
2. **同步技术大表**：将新模型完整参数登记至同目录下档案大表：
   👉 **[官方内置模型参数技术档案大表 (Built-in Models Catalog)](./builtin-models.md)**

---

## 📚 模块化参考资源索引

- 📘 **[模型参数与 apiMode 决策矩阵](./decision-matrix.md)**：三级溯源、字段计算约束、7 档思考白名单与协议判定树。
- 📡 **[网关真机探测与验收标准](./gateway-probes.md)**：Responses / Anthropic / OpenAI / Vision 全协议探测模板与验收指标。
- 📌 **[官方内置模型参数技术档案大表](./builtin-models.md)**：22 款存量内置模型规格大表与厂商网关特性备忘。

