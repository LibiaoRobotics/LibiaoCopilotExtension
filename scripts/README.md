# Libiao Copilot 运维、探针与排障工具箱

本目录收录了 Libiao Copilot 插件的核心安装发布脚本、在线真机抓包探针、日志慢性病分析器以及离线回放回归样本。

---

## 目录结构

```text
scripts/
├── Install-LibiaoCopilot.ps1  # ★ 官方一键安装与 argv.json 提权脚本（Windows PowerShell）
├── Install-LibiaoCopilot.bat  # 双击一键安装入口批处理
├── create-release.ps1         # ★ GitHub Release 自动化发布脚本
├── set-price-notes.js         # 内置模型价格/推荐状态批量标注工具
├── probes/                    # 📡 在线真机抓包探针（直接向网关发流式请求取证）
│   ├── probe-stream-events.js # 多协议原始 SSE 事件抓取器
│   ├── probe-responses-with-tools.js # Responses 协议工具调用流式探针
│   ├── probe-anthropic-glm52.js      # Anthropic 协议原生思考块探针
│   ├── probe-glm-responses.js        # GLM Responses 协议探测
│   ├── probe-openai-thinking-channel.js # OpenAI 思考通道探测
│   ├── probe-tps-qwen38.js           # Qwen 3.8 TPS/TTFT 测速
│   ├── probe-tps-glm52.js            # GLM 5.2 TPS/TTFT 测速
│   └── glm53-effort-test.js          # GLM 5.3 effort 专项测试
├── analyzers/                 # 📊 真实日志慢性病统计与分析工具
│   ├── analyze-backtick-balance.js   # 思考反引号奇偶失衡（跨通道泄漏）分析
│   ├── analyze-delta-vs-done.js      # 网关 delta 污染 vs done 权威发射统计
│   ├── analyze-dup-toolcalls.js      # 重复工具卡片真伪统计
│   ├── analyze-filesearch-turns.js   # 服务端假工具 (file_search) 调用统计
│   ├── analyze-think-leak.js         # 思考泄漏到正文统计
│   ├── analyze-reasoning-tail.js     # 思考尾部特征提取
│   └── extract-turn-events.js        # 从日志提取特定回合完整事件流
└── replay/                    # 📼 离线流式重放与回归验证工具
    ├── glm52-stream-events.json      # GLM-5.2 原生 SSE 抓包真实样本
    ├── minimax-m3-stream.json        # MiniMax 原生 SSE 抓包真实样本
    ├── verify-fix-replay.js          # 修复后逻辑回放验证
    ├── replay-new-parser.js          # 新解析器离线回放
    ├── replay-responses-thinking.js  # Responses 思考流回放
    └── replay-anthropic-usage.js     # Anthropic usage 格式回放
```

---

## 常用工具运行指南

### 1. 快速抓包测试网关 SSE 事件
```powershell
node scripts/probes/probe-stream-events.js
```

### 2. 分析本地最新日志中的思考泄漏情况
```powershell
node scripts/analyzers/analyze-backtick-balance.js "$env:USERPROFILE\.copilot\libiao-copilot\logs\latest.log"
```

### 3. 离线重放真实抓包流验证解析器
```powershell
node scripts/replay/verify-fix-replay.js
```
