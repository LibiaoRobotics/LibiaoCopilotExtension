<div align="center">

<!-- 使用绝对地址：VS Code 扩展页的 README 不解析相对路径图片，GitHub 两侧均可正常显示。
     只指定 width，高度按原图比例（925x363）自动缩放，避免变形 -->

<img src="https://raw.githubusercontent.com/LibiaoRobotics/LibiaoCopilotExtension/main/assets/logo.png" alt="Libiao Copilot Logo" width="240">

# Libiao Copilot

**立镖机器人的 OpenAI 兼容模型供应商扩展，为 GitHub Copilot Chat 提供模型支持**

</div>

本扩展基于 [OAI Compatible Provider for Copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) 构建，采用 MIT 许可分发，详见 [NOTICE.md](NOTICE.md)。

## ✨ 功能特性

- **模型实时发现**：配置模型不再跳过供应商列表。已配置模型与供应商端点实时核对，供应商新上线的模型自动出现，同事无需任何操作
- **模型列表 TTL 缓存**：默认 10 分钟缓存（`libiaoCopilot.modelCacheTtlMinutes`），减少网关请求；刷新失败时自动使用过期缓存兜底
- **原生上下文/思考强度选择**：在 Copilot 模型配置菜单直接选择上下文大小（256K / 512K / 1M）与思考强度，无需编辑 JSON
- **上下文智能管理**：长会话自动压缩（旧消息摘要 + 硬截断），预算内不丢关键信息，可通过 `libiaoCopilot.contextManagement` 关闭
- **多 API 支持**：OpenAI / OpenAI Responses / Ollama / Anthropic / Gemini 五种协议（ModelScope、SiliconFlow、DeepSeek 等）
- **视觉模型**：完整支持图像理解能力
- **多供应商管理**：同时配置多个供应商，独立管理各自 API 密钥
- **同模型多配置**：通过 `configId` 为同一模型定义不同参数配置（如开启/关闭思维链）
- **可视化配置界面**：接入、模型、进阶与最佳实践四大区块，支持配置导入/导出
- **自动重试**：处理 API 错误（429、500、502、503、504），支持指数退避
- **Token 用量**：状态栏实时显示上下文 token 用量
- **Git 集成**：源代码管理面板一键生成提交信息，默认简体中文
- **思维链展示**：在对话界面查看模型推理过程

## 环境要求

- VS Code 1.120.0 或更高版本
- OpenAI 兼容供应商的基础地址与 API 密钥

## ⚡ 快速开始

1. 从 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=libiaorobot.libiao-copilot) 安装（或在 VS Code 扩展面板搜索 **Libiao Copilot**），安装后重新加载窗口。
2. 若已启用 `johnny-zhao.oai-compatible-copilot`，请先禁用，避免模型重复。
3. 打开设置，配置 `libiaoCopilot.baseUrl`（公司网关地址，由管理员提供）。
4. 运行命令面板中的 `Libiao Copilot: 设置 API Key`，输入个人密钥。
5. 打开 GitHub Copilot Chat，选择 Libiao Copilot 提供的模型即可开始对话。
6. 使用模型配置按钮选择上下文大小与思考强度。

> 扩展默认不内置任何供应商地址。未配置 `baseUrl` 时不会拉取模型列表。

### 配置示例

```json
"libiaoCopilot.baseUrl": "https://your-gateway.com/v1",
"libiaoCopilot.models": [
    {
        "id": "deepseek-v4-pro",
        "owned_by": "your-provider",
        "context_length": 1000000,
        "context_sizes": [262144, 524288, 1000000],
        "default_context_size": 524288,
        "max_tokens": 384000,
        "reasoning_effort": "max",
        "reasoning_efforts": ["low", "high", "xhigh", "max"]
    }
]
```

## ✨ 模型发现机制

- 已配置模型仅作为**元数据层**：每个模型与其自身端点（`baseUrl`/`apiMode`，未设置时回退全局配置）的模型列表核对，供应商侧已下线的配置模型会被移除。
- 供应商新增但配置中没有的模型，会以默认元数据自动展示。
- 端点无法查询（未配置地址或 API Key、地址错误、密钥错误、网络错误）时，不展示该端点的任何模型——列表只出现经过核实的模型。全部端点都无法查询时，选择器保留 Libiao Copilot 分区，并以一个不可选的占位条目说明原因。网关短暂故障时由 TTL 内的过期缓存兜底。
- 结果带 TTL 缓存；修改模型配置、baseUrl、TTL 设置或 API Key 会自动清空缓存。

## ✨ 可视化配置界面

本扩展的最大特色。命令面板运行 `Libiao Copilot: 打开配置界面`，或点击状态栏 token 计数项即可打开，四大区块覆盖从接入到调优的全部操作：

- **接入配置**：全局 `baseUrl`、API Key 等基础接入参数，无需手编 JSON
- **模型管理**：增删改供应商与模型，逐字段配置上下文档位、思考强度、采样参数，支持配置导入/导出
- **进阶配置**：高级参数、重试策略、Git 提交信息（模型/语言/自定义提示词）、上下文管理分组可视化调整
- **最佳实践**：一键获得公司 AI 工程防线——
  - 🧠 **用户核心记忆**：一键注入工程思想钢印模板（硬约束、沟通与验证规范），支持「让 AI 把把关」评估记忆有效性，附加记忆（custom-notes.md）与冲突排查、一键清理
  - 🧱 **项目级工程防线**：一键初始化随 Git 流转的项目指令总纲（.github/copilot-instructions.md），自动嗅探技术栈并注入精准按文件类型匹配的模块化规约（applyTo）与场景化技能（Skill）SOP 脚手架
  - ⚡ **终端运行底座**：自动检测 PowerShell 7 环境，未安装时经 winget / 微软官方脚本一键静默安装，并可一键设为 VS Code 默认终端
  - 面板标题实时显示插件版本与打包日期

## ✨ 多 API 模式

通过模型配置的 `apiMode` 参数指定协议：


| 模式               | 端点                                                   | 适用场景                  |
| ------------------ | ------------------------------------------------------ | ------------------------- |
| `openai`（默认）   | `/chat/completions`                                    | 大多数 OpenAI 兼容供应商  |
| `openai-responses` | `/responses`                                           | OpenAI 官方 Responses API |
| `ollama`           | `/api/chat`                                            | 本地 Ollama 实例          |
| `anthropic`        | `/messages`（baseUrl 需包含版本前缀 `/v1`）            | Anthropic Claude          |
| `gemini`           | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Google Gemini             |

### 混合配置示例

```json
"libiaoCopilot.models": [
    {
        "id": "GLM-4.6",
        "owned_by": "modelscope"
    },
    {
        "id": "llama3.2",
        "owned_by": "ollama",
        "baseUrl": "http://localhost:11434",
        "apiMode": "ollama"
    },
    {
        "id": "claude-3-5-sonnet-20241022",
        "owned_by": "anthropic",
        "baseUrl": "https://api.anthropic.com/v1",
        "apiMode": "anthropic"
    }
]
```

## ✨ 多供应商与多配置

- `owned_by`（别名 `provider` / `provide`）用于分组供应商级 API 密钥，存储键为 `libiaoCopilot.apiKey.<供应商小写>`。命令面板 `Libiao Copilot: 设置供应商 API Key` 可分别配置。
- 同一模型 ID 可用 `configId` 区分多份配置（如 `glm-4.6::thinking` 与 `glm-4.6::no-thinking`），在模型选择器中各自独立展示。

## 模型参数

每个模型支持的配置字段（详见 VS Code 设置界面）：

- `id`（必填）：模型标识
- `owned_by`（必填）：模型供应商
- `displayName`：Copilot 界面显示名称
- `configId`：配置 ID，用于同模型多配置
- `baseUrl`：模型级基础地址，未提供时用全局 `libiaoCopilot.baseUrl`
- `apiMode`：API 协议模式
- `family`：模型家族（如 'gpt-4'、'claude-3'），用于启用 Copilot 专属优化
- `context_length`：模型上下文长度，默认 128000
- `context_sizes` / `default_context_size`：Copilot 配置菜单中的上下文档位
- `max_tokens` / `max_completion_tokens`：最大输出 token 数，默认 4096
- `vision`：是否支持视觉，默认 false
- `reasoning_effort` / `reasoning_efforts`：默认推理强度与可选档位
- `enable_thinking` / `thinking_budget` / `thinking`：思维链开关与预算
- `temperature` / `top_p` / `top_k` / `min_p` 等：采样参数
- `frequency_penalty` / `presence_penalty` / `repetition_penalty`：惩罚参数
- `headers`：自定义请求头
- `extra`：额外请求体透传参数
- `include_reasoning_in_request`：助手消息中是否回传 `reasoning_content`（deepseek-v3.2 等）
- `delay`：模型级请求间隔（毫秒），未设置时回退全局 `libiaoCopilot.delay`
- `cache_control`：Anthropic 提示词缓存断点开关（仅 `anthropic` 模式）

### Git 提交信息生成模型

- `libiaoCopilot.commitModel`：用于生成 Git 提交信息的模型 ID（可含 configId，如 `glm-5.2::thinking`），默认 `qwen3.8-flash`。未配置时从推荐模型表兜底；配置的模型不存在时会自动智能纠偏。

## 常见问题

**Q：配置了模型后还能看到网关新模型吗？**
A：能。配置只作为元数据层，供应商新模型会自动出现（默认元数据）；想要完整的上下文/思考强度选择，在 `libiaoCopilot.models` 里补一条配置即可。

**Q：改了配置没生效？**
A：修改设置会自动清空模型缓存；如仍无变化，重新加载 VS Code 窗口。

**Q：模型选择器是空的？**
A：查看错误提示信息，检查 `libiaoCopilot.baseUrl` 与 API Key 是否已配置。未配置时扩展静默不拉取模型。

## 📚 开发者指引

针对插件维护与二次开发，项目基于 VS Code 官方规范建立了模块化 AI 资产体系（instructions / prompts / skills / custom agents），完整规约与导览见 **[.github/copilot-instructions.md](.github/copilot-instructions.md)**。

## 致谢

- [OAI Compatible Provider for Copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（上游项目）
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## 许可

MIT License，详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
