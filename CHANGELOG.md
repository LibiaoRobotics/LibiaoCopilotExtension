# 更新日志

## 未发布

### 新增

- **上下文管理：让 Context Size 旋钮真正生效**。此前 VS Code 原生配置菜单里的「Context Size」选中值只是展示用途（VS Code 本身从不裁剪历史，扩展也不消费它）。现在每次请求前按选中档位执行上下文管理：
  - **摘要压缩**（默认）：当历史超过预算时，用同款模型把较早的对话轮次摘要成一条系统消息（五节结构：角色与目标 / 项目背景 / 对话上下文 / 完成的任务 / 进行中的任务，保留文件名、代码片段、错误消息等细节，输出语言跟随对话），最近轮次与系统消息原样保留。摘要在请求主链路之外发起，不带工具、90 秒超时，失败自动降级。
  - **硬截断兜底**：摘要失败或摘要后仍超预算时，按「轮次原子」从旧到新丢弃：助手工具调用与其工具结果视为一个原子整体保留/丢弃，绝不留下孤儿工具调用；系统消息与最后一轮永不丢弃。
  - **off 总闸**：`libiaoCopilot.contextManagement` 可设为 `off` 完全关闭（账单不可预测或排障时拉闸用），聊天与之前行为完全一致。
  - **预算规则**：预算 = 选中档位 × 0.9（安全系数消化 token 估算误差）；摘要预留 = min(max(256, 预算×30%), `summarizeMaxTokens`)。
  - **配置项**：`libiaoCopilot.contextManagement`（`off` / `summarize`，默认 `summarize`）、`libiaoCopilot.summarizationInstructions`（附加摘要指令，默认空）、`libiaoCopilot.summarizeMaxTokens`（默认 4000，范围 256–32768）。可视化配置面板同步支持三项，配置导出/导入同步携带。
  - **可观测性**：压缩发生时输出日志 `context.compacted`（含原因 `budget_exceeded` / `summarize_failed` / `still_over_budget` 与前后 token 量）并弹出一次性通知。

### 验证清单（装机后按序执行）

1. 把 Context Size 调到最小档（256K），连续对话到超过预算 → 观察输出面板 `context.compacted` 日志出现、聊天不中断。
2. 摘要发生后追问最早话题的细节 → 应能答出（证明摘要保留了内容）。
3. 摘要发生前最后一轮的细节（文件名、最近代码）→ 应无损。
4. `libiaoCopilot.contextManagement` 设为 `off` → 行为与旧版完全一致（拉闸验证）。
5. 错误网关/网络故障时 → 日志出现 `context.summarize.failed`，请求自动降级为硬截断继续。
6. 连续使用三天观察 token 账单与聊天质量。

## 1.0.1

### 修复

- **添加模型时自动选中默认上下文大小**：修复新增模型未保存 `default_context_size` 导致 VS Code 原生配置菜单里「Context Size」没有任何选中项的问题。现在三层兜底保证默认值存在：表单里填写「Context Sizes」时自动填充默认档（可手动改）；提交表单时未填则取最大可选档；最终在模型保存/更新/导入时统一归一化（与配置菜单 schema 的回退逻辑同源），保证新增模型开箱即有默认选中项。

### 移除

- **移除模型健康检查功能**：删除「检查模型可用性」命令与启动自动检查，同步移除 `libiaoCopilot.checkModelsOnStartup`、`libiaoCopilot.startupCheckIntervalHours`、`libiaoCopilot.healthCheckTimeout` 三个配置项。模型可用性已由模型选择器的合并核实机制实时验证（按端点查询供应商 `/models`），聊天时遇到的错误由请求本身直接报出，定期探测不再提供增量价值，徒增通知打扰与网关请求。

## 1.0.0

Libiao Copilot 首个正式版本。基于 [OAI Compatible Provider for Copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) 构建的内部扩展，面向立镖机器人内部网关与 GitHub Copilot Chat 场景重新设计。

### 模型发现与配置

- **模型实时发现**：配置 `libiaoCopilot.models` 不再跳过供应商的模型列表。已配置模型仅作为元数据层，每个模型会与其自身端点（`baseUrl`/`apiMode`，未设置时回退全局配置）的 `/models` 返回核对：供应商侧不存在的配置模型会被移除，供应商新增的模型自动以默认元数据展示，同事无需任何操作即可看到新上线的模型。
- **模型列表 TTL 缓存**：新增 `libiaoCopilot.modelCacheTtlMinutes`（默认 10 分钟）。缓存有效期内不请求供应商；刷新失败时返回过期缓存，保证模型选择器始终有内容。修改模型配置、baseUrl、TTL 设置或 API Key 时自动清空缓存。设为 0 可禁用缓存。
- **未配置 baseUrl 时不拉取**：`libiaoCopilot.baseUrl` 默认不再内置任何地址，未配置时静默不拉取模型列表，不弹窗打扰。已配置 `libiaoCopilot.models` 时同样生效：端点地址或 API Key 未配置、或端点无法查询（地址错误、密钥错误、网络错误）时，均不展示该端点的模型，不再兜底展示全部已配置模型，避免展示无法核实（供应商侧可能不存在）的模型；网关短暂故障的容错仅由 TTL 过期缓存承担（刷新失败且有历史成功缓存时展示缓存）。
- **空列表占位条目**：全部端点都无法查询时，模型选择器仍保留 Libiao Copilot 分区，显示一个带警告图标的不可选占位条目，条目文本直接展示原因（无需悬停或点击）。文案按 HTTP 状态码区分：401/403 提示权限不足、检查 API Key；其余失败（404、无法连接等）一律提示检查基础地址，不混提 Key。

### 公司模型开箱即用

- 内置公司网关四个模型的官方元数据（上下文 1M、上下文档位选择、推理强度选择、视觉能力标记）：`qwen3.8-max-preview`、`qwen3.8-max`、`deepseek-v4-pro`、`deepseek-v4-flash`。
- **原生 Copilot 配置菜单**：模型选择器内直接选择上下文大小（256K / 512K / 1M）与思考强度，无需编辑 JSON。
- **模型健康检查**：新增「检查模型可用性」命令；启动时自动检查（每 24 小时限一次），仅在模型不可用时提醒。

### 本地化与品牌

- 命令标题、配置项说明、README 全部中文化。
- Git 提交信息生成语言默认简体中文（`libiaoCopilot.commitLanguage`）。
- 使用公司 logo 与品牌标识，作者信息更新为立镖机器人。

### 继承自上游的核心能力

- OpenAI / OpenAI Responses / Ollama / Anthropic / Gemini 五种 API 模式。
- 视觉模型、工具调用、思维链/推理内容展示。
- 多供应商管理与独立 API Key、同模型多配置（`configId`）。
- 可视化配置界面（供应商/模型管理、配置导入导出）。
- API 错误自动重试（指数退避）、请求限速、自定义请求头与 `extra` 透传参数。
- 状态栏 token 用量实时统计。
- 源代码管理面板一键生成提交信息。

---

> 上游项目的完整历史记录见 [oai-compatible-copilot CHANGELOG](https://github.com/JohnnyZ93/oai-compatible-copilot/blob/main/CHANGELOG.md)。本文件从 1.0.0 起独立维护。
