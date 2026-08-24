---
name: model-benchmark
description: Libiao Copilot 模型的连通性探测、首字延迟 (TTFT)、生成速度 (TPS) 压测与排行榜生成技能。当用户要求对网关模型进行批量测速、性能压测、健康体检或生成 TPS 报告时使用。
---

# 模型性能与 TPS 压测技能 (Model Benchmark Skill)

本技能用于对 Libiao Copilot 支持的全部或指定网关模型执行连通性探测、首字延迟（TTFT）测量、以及生成速度（Tokens/s）基准测试。

---

## ⚙️ 测试标准与度量规则

* **测试提示词**：要求模型生成一篇约 1000~1100 tokens 的结构化长文（例如解释分布式一致性算法 Raft）。
* **并发度**：默认 3 路并发测试池（`runModelTests` 机制）。
* **超时控制**：单模型单次请求 60 秒硬超时。
* **度量指标**：
  - **TTFT（首字延迟）**：从发起请求到收到首个非空数据块（含思考 Token）的时间（毫秒）。
  - **生成耗时**：从首个非空数据块到最后一个数据块的纯生成流式跨度。
  - **真实 TPS**：$\text{TPS} = \frac{\text{总输出 Tokens}}{\text{生成耗时 (秒)}}$（整数呈现，不带小数）。
  - **黑名单支持**：遵循 `libiaoCopilot.modelTestExclude` 配置，自动跳过被排除的模型。

---

## 📊 输出排行榜格式示例

测试完成后，以清晰的 Markdown 表格汇报结果：

| 模型 ID | 显示名称 | 协议模式 | TTFT (ms) | 总耗时 | 输出 Token (正文/思考) | 实际 TPS | 状态 |
|---|---|---|---|---|---|---|---|
| `qwen3.8-max` | 👁️ Qwen 3.8 Max | responses | 850ms | 4.2s | 1,050 (320 / 730) | **250 T/s** | ✅ 正常 |
| `deepseek-v4-pro` | DeepSeek V4 Pro | responses | 1,200ms | 5.8s | 1,120 (450 / 670) | **193 T/s** | ✅ 正常 |
| `glm-5.2` | GLM-5.2 | anthropic | 620ms | 3.5s | 980 (0 / 980) | **280 T/s** | ✅ 正常 |
| `claude-opus-5` | 👁️ Claude Opus 5 | openai | 1,500ms | 8.1s | 1,020 (0 / 1,020) | **126 T/s** | ✅ 正常 |

---

## 🛠️ 自动化体检指令

当用户要求体检时，可调用 `src/modelTester.ts` 对应逻辑或执行测试脚本，捕获超时、401/404/429 报错，并给出明确的网关渠道优化建议。
