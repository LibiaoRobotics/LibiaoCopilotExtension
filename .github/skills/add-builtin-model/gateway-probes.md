# 网关真机探测与验收标准 (Gateway Probes & Acceptance)

本文档归档 Libiao Copilot 新增/修改内置模型时的网关真机连通性、思考通道与多模态探测命令模板，供 `add-builtin-model` 技能按需查阅。

---

## 1. 探测环境与鉴权变量

- **网关地址**：`https://newapi.libiaorobot.com/v1`
- **鉴权变量**：必须使用前置初始化的 `$env:NEWAPI_KEY`，严禁在命令中硬编码明文 Key。

---

## 2. 各协议专用探测模板（PowerShell）

### A. Responses 模式探测（测试 `/v1/responses`、思考流与 effort 档位）
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/responses" `
  -H "Authorization: Bearer $env:NEWAPI_KEY" -H "Content-Type: application/json" `
  -d '{"model":"<模型id>","input":"1+1等于几？请一步步推理后只回答最终数字","max_output_tokens":256,"reasoning":{"effort":"high"}}'
```

### B. Anthropic 模式探测（测试 GLM / Claude `/v1/messages` 与 32K 思考预算）
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/messages" `
  -H "x-api-key: $env:NEWAPI_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" `
  -d '{"model":"<模型id>","max_tokens":1024,"thinking":{"type":"enabled","budget_tokens":2048},"messages":[{"role":"user","content":"一步步推理：13*17等于多少？最后给答案。"}]}'
```

### C. OpenAI (Chat) 模式探测（测试 `/v1/chat/completions` 与思考通道）
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/chat/completions" `
  -H "Authorization: Bearer $env:NEWAPI_KEY" -H "Content-Type: application/json" `
  -d '{"model":"<模型id>","messages":[{"role":"user","content":"一步步推理：13*17等于多少？最后给答案。"}],"stream_options":{"include_usage":true}}'
```

### D. Vision 图像理解真机探测（100x100 纯色标准测试图，严禁 1x1 假图）
```powershell
curl.exe -s -w "`nHTTP_STATUS:%{http_code}" -X POST "https://newapi.libiaorobot.com/v1/chat/completions" `
  -H "Authorization: Bearer $env:NEWAPI_KEY" -H "Content-Type: application/json" `
  -d '{"model":"<模型id>","messages":[{"role":"user","content":[{"type":"text","text":"图片是什么颜色？"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVHhe7cExAQAAAMKg9U9tCF8gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIB3A1pNAAFB5mSmAAAAAElFTkSuQmCC"}}]}],"max_tokens":100}'
```

---

## 3. 三重通过判定标准（Done Criteria）

1. **HTTP 状态码**：必须为 `HTTP 200`（返回 400 说明端点协议、参数字段或 effort 档位不被网关支持）。
2. **思考出字验证**：
   - Responses 模式：返回 `reasoning_text` 或 `reasoning_tokens > 0`；
   - Anthropic 模式：返回 `type: "thinking"` 数据块；
   - OpenAI 模式：返回 `reasoning_content` 或正文包含 `<think>` 标签。
3. **档位极值验证**：若配置了 `reasoning_efforts` 数组，至少测试最低档（`low`/`minimal`）与最高档（`xhigh`/`max`），确认网关均可正常执行且不抛 400 错误。
