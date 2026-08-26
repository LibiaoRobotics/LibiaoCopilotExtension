---
description: 🧪 运行全部自动化单元测试并输出测试报告
name: lb-test
argument-hint: [可选：测试过滤器]
---

请进入 `libiao-copilot` 目录，执行 `npm test`（编译并拉起 vscode-test），检查全部用例是否 PASS。若有失败用例，请定位并指出具体报错原因。

若提供了过滤参数 `${input:testFilter:具体测试名称或模式}`,则只关注对应模块或用例的执行结果。
