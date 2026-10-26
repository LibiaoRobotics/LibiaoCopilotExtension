---
description: NewAPI 异构网关的地址、鉴权变量、权限边界与探测口径红线
applyTo: "scripts/**"
---

# NewAPI 网关探测与权限边界 (Gateway Access & Probes)

## 1. 地址与鉴权
- **网关地址**：`https://newapi.libiaorobot.com/v1`。
- **鉴权变量**：一律使用前置初始化的 `$env:NEWAPI_KEY`，严禁在脚本或命令中硬编码明文 Key。
- **产品代码红线**：默认 `baseUrl` 必须留空，严禁在任何源码或默认配置中硬编码内部网关地址。
- 探测命令模板见 [skills/add-builtin-model/gateway-probes.md](../skills/add-builtin-model/gateway-probes.md)，本文只记录边界与判定规则，不重复命令。

## 2. 权限边界（2026-09-20 实测）
- 本机 `$env:NEWAPI_KEY` 所属组为 `Developers (distributor)`，**渠道白名单极窄**：`GET /v1/models` 仅返回 5 款 —— `deepseek-v4-flash-vision-exp`、`gemini-3.8-flash`、`glm-5.3-aliyun`、`qwen3.8-flash`、`qwen3.8-max`。
- 已发布的内置模型（如 `glm-5.3-flash`）亦可能返回 503 `model_not_found`，且 `/v1/messages`、`/v1/chat/completions`、`/v1/responses` 三个端点表现一致。

## 3. 判定红线
- `model_not_found` **不得**用于判定“该模型在网关不存在”，只能说明当前 Key 无权访问。
- 新增内置模型时，`add-builtin-model` 第 3 步的真机探测必须使用全权限 Key；若只能拿到窄权限 Key，必须在模型文档中显式标注「网关未真机验证」并写明未验证字段（`id` 是否存在、`vision` 是否成立等）。

## 4. 命令纪律
- 终端多行 pwsh 命令易被 shell integration 截断，探测必须使用**单行** `Invoke-RestMethod`。
- `OPENAI_API_KEY` + `OPENAI_BASE_URL`（dashscope.aliyuncs.com）是另一条独立链路，与本网关无关，不得混用变量。
