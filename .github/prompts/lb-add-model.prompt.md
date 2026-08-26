---
description: ➕ 新增内置模型：权威溯源、网关探测验证、安全写入与全量回归
name: lb-add-model
argument-hint: [模型名/型号]
---

请严格按照 `add-builtin-model` 技能的 SOP 与红线，添加内置模型 `${input:modelName:要添加的模型名，如 deepseek-v5}`，并同步：

step 1：检查并初始化 `NEWAPI_KEY`（若缺失则通过掩码输入，变量名定死为 `NEWAPI_KEY`）；
step 2：权威溯源确定模型物理参数与 apiMode（遵循三级溯源，严禁无据脑补）；通过 `curl` 向网关发送真实请求验证 HTTP 200、思考出字与 effort 档位采纳；
step 3：安全写入 `package.json`（严禁 JSON.parse/stringify 整体重写，严禁手写 Emoji），确定 priceNote 标注并执行 `npm run verify:models` 全量自检；
step 4：执行 `npm test` 全量回归并同步档案大表。

整个过程中严格遵守技能红线：apiMode 与思考字段严格匹配、档位限定 7 档白名单、`include_reasoning_in_request` 只允许 DeepSeek 系列开启。若遇到任何无法查证的参数，立即中断并报告，不得脑补。
