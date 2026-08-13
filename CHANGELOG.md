# 更新日志

## 1.0.3

### 修复

- 修复 `openai-responses` 模式下回复内容重复一倍的问题（网关在流式末尾发送空增量时，全文兜底逻辑误将整段正文重复输出）。
- 修正 `logLevel` 配置项描述中的日志目录路径。

## 1.0.2

### 新增

- **上下文管理生效**：请求前按配置菜单选中的 Context Size 档位执行上下文管理：
  - `summarize`（默认）：历史超过预算（档位 × 0.9）时，用同款模型摘要较早轮次，最近轮次与系统消息原样保留；摘要失败自动降级为硬截断。
  - `off`：完全关闭，行为与旧版一致。
  - 新增配置项：`libiaoCopilot.contextManagement`、`libiaoCopilot.summarizationInstructions`、`libiaoCopilot.summarizeMaxTokens`（可视化面板同步支持）。

### 修复

- 修复 VSIX 缺失运行时依赖（`@microsoft/tiktokenizer`）导致扩展激活崩溃的问题。

## 1.0.1

### 修复

- **Anthropic 端点简化**：`anthropic` 模式请求路径改为直接拼接 `/messages`，`/v1` 前缀由 `baseUrl` 携带。**已配置的用户需在 baseUrl 中补上 `/v1`，否则会 404。**
- 新增模型时自动填充默认 Context Size，修复配置菜单中「Context Size」无选中项的问题。

### 移除

- 移除模型健康检查功能及 `checkModelsOnStartup`、`startupCheckIntervalHours`、`healthCheckTimeout` 三个配置项（可用性已由模型选择器实时核实）。

## 1.0.0

首个正式版本，基于 [OAI Compatible Provider for Copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) 构建，面向立镖机器人内部网关与 GitHub Copilot Chat 场景重新设计。

### 模型发现与配置

- **模型实时发现**：已配置模型与端点 `/models` 返回核对，供应商侧不存在的自动移除，新上线模型自动展示。
- **模型列表 TTL 缓存**：新增 `libiaoCopilot.modelCacheTtlMinutes`（默认 10 分钟，0 为禁用），刷新失败时回退过期缓存。
- **未配置 baseUrl 时不拉取**：默认不内置地址，端点未配置或不可查询时静默跳过，不展示无法核实的模型。
- **空列表占位条目**：全部端点不可查询时，模型选择器显示带原因说明的占位条目（401/403 提示检查 API Key，其余提示检查基础地址）。

### 公司模型开箱即用

- 内置公司网关四个模型元数据：`qwen3.8-max-preview`、`qwen3.8-max`、`deepseek-v4-pro`、`deepseek-v4-flash`（上下文 1M、档位与推理强度选择、视觉能力标记）。
- 原生 Copilot 配置菜单内直接选择上下文大小（256K / 512K / 1M）与思考强度。
- 模型健康检查命令与启动自动检查（1.0.1 已移除）。

### 本地化与品牌

- 命令、配置说明、README 全部中文化。
- Git 提交信息默认简体中文（`libiaoCopilot.commitLanguage`）。
- 使用公司 logo 与品牌标识。

### 继承自上游的核心能力

- OpenAI / OpenAI Responses / Ollama / Anthropic / Gemini 五种 API 模式。
- 视觉模型、工具调用、思维链展示。
- 多供应商管理与独立 API Key、同模型多配置。
- 可视化配置界面（供应商/模型管理、配置导入导出）。
- API 错误自动重试、请求限速、自定义请求头与 `extra` 透传参数。
- 状态栏 token 用量统计、源代码管理面板一键生成提交信息。

---

> 上游项目的完整历史记录见 [oai-compatible-copilot CHANGELOG](https://github.com/JohnnyZ93/oai-compatible-copilot/blob/main/CHANGELOG.md)。本文件从 1.0.0 起独立维护。
