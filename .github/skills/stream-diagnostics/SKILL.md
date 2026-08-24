---
name: stream-diagnostics
description: Libiao Copilot 插件的流式协议抓包调试与日志故障诊断技能。当用户报告模型回复重复、思考泄漏到正文、服务端工具异常、HTTP 400 报错、或需要向网关发起原始 SSE 数据流抓包分析时使用。
---

# 流式抓包与日志排障技能 (Stream Diagnostics Skill)

本技能用于诊断 Libiao Copilot 在流式（SSE）传输、多协议适配、以及 NewAPI 异构网关对接过程中的各类疑难杂症。

---

## 🔍 日志取证总入口

插件的真实运行日志自动保存在用户本地目录：
* **日志路径**：`C:\Users\<用户名>\.copilot\libiao-copilot\logs\`
* **快速过滤报错命令（PowerShell）**：
  ```powershell
  $logDir = "$env:USERPROFILE\.copilot\libiao-copilot\logs"
  # 查找最新日志中的报错与异常请求
  Get-ChildItem $logDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content | Select-String "error|400|401|429|required\["
  ```

---

## 🧬 常见异构网关流式慢性病与诊断签名

| 症状现象 | 根本原因 | 关键日志签名 | 防御与修复模块 |
|---|---|---|---|
| **回答内容整段 2× 重复** | 网关在发完正文后追加发送了一个空内容的 `output_text.delta`，旧状态机复位导致后续 `output_text.done` 误判为未发过正文，整段重发。 | 日志中出现空 `output_text.delta`，随后紧跟完整 `output_text.done`。 | `src/openai/openaiResponsesApi.ts`：空 delta 直接 return，单调置位 `_sawTextDelta` 永久熔断 done 重发。 |
| **正文出现英文思考尾巴 + 孤儿 `</think>`** | 模型将思考的后半截续写进了正文通道（无开标签、直接孤儿闭标签收尾）。 | 正文首个 chunk 触发，且 reasoning 流文本反引号奇偶失衡（被拦腰截断）。 | `src/openai/openaiResponsesApi.ts` 中的 `runLeakGuard`（思考跨通道泄漏守卫，自动回填折叠区）。 |
| **模型回复空白或中途报工具不存在** | 模型自发调用了网关未开放的服务端假工具（如 `file_search_call`, `web_search_call`）。 | 日志出现 `output_item.added` 为 `file_search_call`，生命周期完整但结果为空。 | `src/openai/openaiResponsesApi.ts` 中的 `handleServerSideToolItem`（自动转换为同名客户端调用并回传不可用错误，引导模型自愈）。 |
| **UI 连续弹出两张相同的工具卡片** | 网关把上一个工具调用的完整参数作为 delta 路由到了下一个 item，旧解析器在 delta 阶段提前抢跑发射。 | 同一回合内连续触发同名同参的 `tool_call`。 | `src/openai/openaiResponsesApi.ts`：delta 阶段只累积不抢跑发射，收敛到 `output_item.done` 权威发射。 |
| **Gemini 报 400 `property is not defined`** | 白名单过滤误把 `properties` 里的用户自定义参数属性名当作 schema 关键字剔除。 | 日志中出现 `required[N]: property is not defined` 且 `properties: {}`。 | `src/gemini/geminiApi.ts`：`stripUnsupportedGeminiSchemaKeys` 对 `properties` 映射做保护。 |

---

## 🛠️ 现成探针与分析器工具箱（在 libiao-copilot 目录运行）

### 1. 抓取网关底层原始 SSE 流事件
```powershell
# 多协议通用流式探针
node scripts/probes/probe-stream-events.js

# Responses 协议工具调用流探针
node scripts/probes/probe-responses-with-tools.js

# Anthropic 协议原生思考块探针
node scripts/probes/probe-anthropic-glm52.js
```

### 2. 日志慢性病量化分析
```powershell
# 分析最新日志中的思考泄漏与反引号失衡
$latestLog = (Get-ChildItem "$env:USERPROFILE\.copilot\libiao-copilot\logs" -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
node scripts/analyzers/analyze-backtick-balance.js "$latestLog"

# 统计日志中 delta 污染 vs done 权威发射样本
node scripts/analyzers/analyze-delta-vs-done.js "$latestLog"
```

### 3. 离线重放真实样本验证解析器
```powershell
# 灌入真实抓包样本回放验证修复逻辑
node scripts/replay/verify-fix-replay.js
```
