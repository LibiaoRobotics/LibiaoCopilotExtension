---
description: 企微智能机器人对话桥接（wechatBridge*）的双向数据流、正文来源、协议事实与安全不变量
applyTo: "**/wechatBridge*.ts,**/WechatNotify*.ps1,assets/hooks/**"
---

# 企微对话桥接（WeChat Bridge）

改动 `src/wechatBridge*.ts`、`assets/hooks/WechatNotify.ps1`、`assets/hooks/WechatInteract.js` 前先读完本文件。以下事实全部为真机实测或官方文档核实，标注了日期；改动前先确认是否仍然成立。

## 1. 两条数据流

| 方向 | 通道 | 触发 |
|---|---|---|
| 企微 → VS Code | 长连接回调 → `aibot_respond_msg` 回原 `req_id` | 用户在企微给机器人发消息 |
| VS Code → 企微 | `aibot_send_msg` 主动推送 | transcript 轮次泵（500ms）发现**任一**轮次结束 |

- 正文**不含思考过程**：transcript 里根本不存在 thinking 事件，正文只存在于 `assistant.message.content`，属结构性排除，不要再去加"过滤思考"的代码。
- 只在 VS Code 侧发起的轮次也推送；注入来源的轮次由等待者领走走 `.respond`，不会重复推。
- **正文只取主会话**：子代理（`runSubagent`）的 `user.message`/`assistant.message` 也写进同一个 transcript，且挂在同一条 `parentId` 链上，没有任何"我是子代理"标记（2026-10-31 实测 191 行 transcript 确认）。判据只能是 `runSubagent` 的 `toolCallId`：它的 `execution_start` → `execution_complete` 之间的事件全不属于本轮。不隔离的后果是手机端收到 20+ 段中间说明加整份调研报告，且子代理自己的 `user.message` 会把主轮提前 flush，顺序全乱。异常中断（关窗、停止）不写 `complete`，所以有 30 分钟 TTL 兜底，否则之后所有真实轮次都会被丢掉。
- **「等你选择」只能走 `preToolUse` hook**：`vscode_askQuestions` 回答前不返回、不写 `turn_end`，本轮永远判不了结束；它的 `tool.execution_start` **也观测不到**——transcript 只在 `flush()` 时真正写盘，而 `flush()` 全仓只在 hook 执行前与上下文压缩前调用。2026-10-31 实测：等待期间文件大小 686185 字节，90 秒内零增长，答完那次才一次写进 `start`（事件时间戳 13:51:09）与 `complete`（13:52:35）。所以按顺序消费时 `start` 与 `complete` 必然同一批到达，即时消费也会被当成“已答完”而永不推送（曾据此上过一版从未生效的实现）。
  现在的通道：`.github/hooks/WechatInteract.js`（`PreToolUse`，命令 `node`，不用 pwsh）把 `{toolCallId, arguments}` 追加到 `<扩展数据目录>/wechatPending/<sessionId>.jsonl`，`InteractionInbox` 增量跟读并渲染成 `pushMarkdown(..., "live-interaction")`。三条不变量：hook 必须 `exit 0`（`exit 2` = deny）、stdout 必须为空、目录名 `wechatPending` 两边硬编码必须一致。hook 配置按轮次缓存，改了要下一轮才生效；workspace trust 与 `chat.useHooks` 任一关闭就静默不跑。这条**不做来源去重**：企微发起的轮次卡在提问上，手机端更需要知道。
- **通用工具审批拍不了**：`preToolUse` hook 的输入里没有「这个工具会不会弹确认」的字段（它在 `prepareToolInvocation` 之前触发），无法区分自动批准与待审批。只对 `vscode_askQuestions` 这类确定会阻塞的工具精确可靠，不要靠“长时间没有 complete”去猜（长命令会误报）。
- **提醒是双向的，但作答路径必须拦住注入**：`vscode_askQuestions` 在核心里不是确认框，而是往对话追加 `questionCarousel` 进度部件后 `await` 它的 `DeferredPromise`（`askQuestionsTool.ts:222-232`），答案只能来自 UI。企微回一条「1」若走正常注入路径，`chatWidget.ts:3964-3975` 发现 `requestNeedsInput` 为真、`requestInProgress` 为假，就 `cancelCurrentRequestForSession('acceptInput-needsInput')`，轮播被 `dismiss(undefined)`、提问抛 `CancellationError` 而被**跳过**，「1」变成一条**新的 user 消息**。所以 `handleInboundMessage` 在入队**之前**先看 `pendingInteraction`：能答就提交答案，答不了也必须回提示，**绝不退回注入**。
  - 提交通道是内部命令 `_chat.notifyQuestionCarouselAnswer(resolveId, answers)`（`chat.shared.contribution.ts:290`，语音输入在用），失败是静默的。
  - `resolveId = chatStreamToolCallId ?? callId`（`askQuestionsTool.ts:207`），而 `chatStreamToolCallId = props.toolCall.id.split('__vscode')[0]`（`toolCalling.tsx:325-327`）；hook 拿到的 `tool_use_id` 是 `props.toolCall.id` **原值**（`chatHookService.ts:350-356`）。二者**不相等**，必须用 `toResolveId()` 削掉 `__vscode` 后缀，否则命令匹配不上且不报错。
  - 答案键 `${resolveId}:${index}`；值：文本题 → 字符串，单选 → `{selectedValue}`，多选 → `{selectedValues}`；**选项值只能传 `options[].label` 原文**，传带 ` — description` 的显示文本会匹配不上。`answers` 传 `undefined` = 全部跳过（工具正常返回 `skipped: true`，不抛取消）。
  - **时序坑**：PreToolUse hook 在 `toolCalling.tsx:301` 触发，而轮播追加与监听注册在 `askQuestionsTool.ts:219-229`，比它晚。**在 hook 里同步调这个命令必定空转**。现在的实现在用户回复时（秒级之后）才调，所以安全；若将来改成一收到 sidecar 就自动作答，必须先延后到轮播注册之后。
  - 监听器守卫 `event.resolveId !== carousel.resolveId || carousel.isUsed` 会在工具 `finally` 里 dispose（`:239`），工具返回后命令即失效；autopilot / `chat.autoReply` 会预置 `isUsed = true`，外部作答一律被挡。所以待答状态必须带 10 分钟 TTL，过期就不能再假装作答成功。
  - 扩展侧没有、也不该有「取消当前轮次」的调用：取消是 VS Code 自己在提交新消息时做的，扩展不知情。

## 2. 正文来源必须是 transcripts，不是 chatSessions

- 首选：`<workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl`，逐条追加，`turn_end` 到可读无滞后。
- 兜底：`<workspaceStorage>/<hash>/chatSessions/<sessionId>.jsonl`（`ChatSessionScanner`）。正文 = `requests[N].response[]` 中「无 `kind` + `value:string`」的部件，`requests[N].result` 出现即本轮完成。
- **chatSessions 是定期批量刷盘的**（实测 2034 个样本全部落在 `:29–:32` 与 `:47–:50` 两个窗口），落盘时刻比请求自身 `timestamp`/`timestamp+timings.totalElapsed` 晚 3.5s–26.4s，最坏 40s。历史上企微"回复慢几十秒"就是它，1 秒轮询 1:1 继承了刷盘延迟。取正文别再用它。
- 轮次边界：一次请求会拆成多个 `assistant.turn_end`（每个工具步骤一个），所以判据是「最后一条是 `turn_end` 且静默 500ms」。依据：有下一步时下一个事件 181/184 次间隔 0ms、3 次 1ms，真实轮次边界 63ms 起。
- `completed=true` 但 `response` 里 `text` 部件数为 0 是真实存在的（只调工具不产出文本）。主动推送与 `aibot_respond_msg` 一律发空正文，不要推占位文案刷屏（2026-10-31 起去掉「本轮没有产出文本回复…」）。
- `transcripts/` 目录只在有过对话后才出现，且不是每个会话都有（曾见 21 个 transcript vs 222 个 chatSessions）；不存在时走兜底，别缓存失败。

## 3. `workbench.action.chat.open` 语义（vscode-src 源码已确认）

- 不传 `isPartialQuery` 时 `query` **立即提交**；`preserveInput:true` 仍提交，只保留草稿、不带草稿附件、不解析 slash。
- 落盘 `requests[N].message.text` 与 `query` 逐字符相同（`chat.open` 用 `agentIdSilent`，不加 `@agent ` 前缀），桥接因此能靠 prompt 原文精确命中轮次。
- 命令返回体只含工具确认态，**不含**完整 markdown，别指望它当返回通道。
- 静默 rejected（不产生轮次）的条件：query 空白、会话只读、`isInputBlocked`、有挂起的模型选择。
- **注入会排队**：上一轮没跑完时请求要等它结束才创建，实测晚 43.9s；该请求的 `timestamp` 仍记提交时刻，不能用它判断注入是否成功。判定「注入没有生效」必须先排除会话正在跑（`LiveTurnScanner.isBusy()`），否则长轮次必然误判。

## 4. 企微协议事实（官方文档 101836 / 101837，2026-10-10 版，2026-10-31 复核）

- 长连接必须用 `ws`：扩展宿主的全局 WebSocket（undici）连 `wss://openws.work.weixin.qq.com` 必 1006。
- `aibot_respond_msg`（回复回调）：支持 `stream`，首次推送后 10 分钟内必须 `finish`；用户发消息起 24 小时回复窗口。因此不要在长轮次开始前抢先回"处理中"——超过 10 分钟的 agent 轮次会让消息永远停在未完成态。
- `aibot_send_msg`（主动推送）：`chatid` 单聊填 userid；**`chat_type` 必须显式 `1`**（不填/填 0 服务端优先按群聊处理）。支持 `markdown`/`template_card`/`file`/`image`/`voice`/`video`，**不支持 `stream`**。前提是用户此前给机器人发过消息。`markdown.content` ≤ 20480 字节 UTF-8。
- 限流：**每个会话 30 条/分钟、1000 条/小时，回复与主动推送合并计数**。主动推送侧留余量（代码里 25/分钟、900/小时）。
- 回调 `body` 键为 `msgid/aibotid/chattype/from/msgtype/response_url/text`（`response_url` 文档未提，本实现不用）。`from.userid` 是 32 字符**加密值**，白名单必须存这个加密值 → 面板的「授权最近一位发送者」按钮就是干这个的。
- **事件回调的类型在 `body.event.eventtype`**，事件体在 `body.event.<eventtype>` 下（消息 callback 才是平铺的）。曾按 `body.disconnected_event` 探测，导致被顶号事件永不触发、`markKicked` 从不执行。
- 模板卡片 `button_interaction` 必填 `task_id`（`[0-9A-Za-z_-@]`，≤128 字节），`button_list` ≤6 个、`text` ≤10 字。卡片点击回 `aibot_respond_update_msg`（`response_type:"update_template_card"`）必须透传该事件 `req_id`，**只有 5 秒窗口**，错过只是卡片不更新，无数据损失。

## 5. 安全与去重不变量

- 授权卡片：点击者 `from.userid` 必须等于发起时选定的目标，否则拒绝。否则卡片被转发后他人点「允许」就把自己写进白名单，等于拿到本机 agent 使用权。
- 群通知去重：注入前把 prompt 的 `sha256(UTF-8, trim)` 追加到 `%TEMP%/libiao-copilot-bridge-prompts.jsonl`（只存哈希，30 分钟 TTL），`WechatNotify.ps1` 的 `Test-BridgeInjectedPrompt` 命中就跳过群通知。两侧哈希算法已实测一致（含 emoji）。
- 去重开关在扩展侧：`notifyGroupForBridgeTurns`（默认 false = 跳过）。要改行为改这里，**别去动 ps1**。
- `assets/hooks/WechatNotify.ps1` 改行为必须递增 `$ScriptVersion`（扩展动态解析头部版本号判断「工作区副本过时」，无硬编码常量）；工作区副本在 `<workspace>/.github/hooks/`，同步时要一并覆盖，否则面板会一直提示过时。
- `assets/hooks/WechatInteract.js` 是 `PreToolUse` 的命令体，工作区副本同样要同步（面板的「创建企微联动」会逐字复制，已存在则跳过）。它不发 webhook、只落盘 sidecar，所以没有版本号机制。**缺这个文件比不提醒更糟**：`node` 会非 0 退出，核心把每次工具调用的 hook 失败当 warning 报给用户。

## 6. 排查证据

- 桥接日志：`~/.copilot/libiao-copilot/logs/libiao-copilot-<yyyyMMdd>.log`，筛 `"tag":"wechat-bridge"` 即可看全序列（`accepted-message` → `turn-finished{ok,sent,durationMs,replyLength}`；主动推送侧有 `live-turn-pushed` / `live-turn-push-rejected` / `live-turn-no-target` / `live-turn-empty` / `live-turn-push-unsent`）。
- 该文件**增长极快**（debug 级 `responses.stream.chunk` 落盘每个 SSE delta 原文，单日可达 888MB+），按尾部字节读，别整文件 grep。
- 「扩展文件已更新但窗口还是旧代码」判定：比对 Code.exe 扩展宿主进程 `CreationDate` 与 `out/*.js` 的 `LastWriteTime`。窗口内 `Developer: Reload Window` 足够（`argv.json` 提案授权首次启动即生效，无需全退）。
- 端到端闭环实测参照（2026-10-31 20:51，1.5.2 真机）：`auth-card-sent` → 企微点允许 → `inbound-event: template_card_event` + `auth-card-answered{accepted:true,userIdLength:32}` → `accepted-message{length:2}` → VS Code 真的起了一轮对话。
- 「等你选择」排查：`<workspaceStorage>/<hash>/GitHub.copilot-chat/wechatPending/<sessionId>.jsonl` 有行就说明 `PreToolUse` 真的在提问前跑了。要验证 hook 是否触发（而不只是脚本逻辑），临时把命令换成一个把 stdin 写到 `%TEMP%` 的探针脚本，自己调一次 `vscode_askQuestions` 看文件有没有落地——比读 transcript 猜可靠。
