---
name: safe-unicode-edit
description: 在 Libiao Copilot 代码库中安全处理 Emoji、Unicode 码点与 PowerShell 脚本编码的专项防损技能。当需要编辑包含 Emoji (👁️/🖼️ 等)、修改 package.json、处理特殊字符、或保存 PowerShell .ps1 脚本时使用。
---

# Unicode 与 Emoji 安全编辑技能 (Safe Unicode Edit Skill)

本技能用于防止在编辑包含 Emoji、特殊字符、以及 Windows PowerShell 脚本时发生编码损坏与语法爆炸。

---

## 🚨 历史血泪事故与避雷铁律

1. **Emoji 写入损坏（U+FFFD 乱码）**：
   - 普通文件编辑工具在写入复杂 Emoji 时极易将其破坏为 `U+FFFD` 占位乱码且返回“成功”。
   - **铁律**：凡涉及 Emoji 的代码与配置文件写入，**一律使用 Node 脚本按 Unicode 码点转义写入**，并用 `JSON.parse` / 码点检查进行二次核验。
2. **PowerShell 5.1 编码爆炸**：
   - Windows PowerShell 5.1 默认按系统 GBK 编码读取无 BOM 的 `.ps1` 脚本，导致中文注释和中文提示词解析爆炸。
   - **铁律**：所有 `.ps1` 脚本保存时**必须添加 UTF-8 BOM 头（`0xEF, 0xBB, 0xBF`）**。

---

## 📌 核心 Emoji 码点标准参照表

| 符号 | 业务含义 | Unicode 码点转义 (TS/JS) | package.json 代理对转义 | Code Units 长度 |
|---|---|---|---|---|
| **👁️** | Vision 视觉模型眼球图标（默认） | `\u{1F441}\uFE0F` | `\uD83D\uDC41\uFE0F` | 3（U+1F441 代理对 + U+FE0F） |
| **🖼️** | Vision 视觉模型图片图标 | `\u{1F5BC}\uFE0F` | `\uD83D\uDDBC\uFE0F` | 3（U+1F5BC 代理对 + U+FE0F） |
| **⚠️** | 警告提示符 | `\u{26A0}\uFE0F` | `\u26A0\uFE0F` | 2 |

---

## 🛠️ 安全操作 SOP

### 1. 修改含 Emoji 的文件（如 package.json）
使用 Node 脚本进行精确字符串替换并验证：
```powershell
node -e '
const fs = require("fs");
let content = fs.readFileSync("package.json", "utf8");
// 替换逻辑，使用 \uD83D\uDC41\uFE0F
content = content.replace("...", "...");
// 校验 JSON 合法性
JSON.parse(content);
fs.writeFileSync("package.json", content, "utf8");
'
```

### 2. 写入/保存 PowerShell 脚本
```powershell
node -e '
const fs = require("fs");
let text = "..."
const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
const buf = Buffer.concat([bom, Buffer.from(text.replace(/^\uFEFF/, ""), "utf8")]);
fs.writeFileSync("script.ps1", buf);
'
```
* **保存后必做验证**：使用 PowerShell AST 语法解析器确认语法无误：
  ```powershell
  $errs = @(); [System.Management.Automation.Language.Parser]::ParseFile('.\script.ps1', [ref]$null, [ref]$errs) | Out-Null; if ($errs.Count -eq 0) { Write-Host 'Syntax OK' } else { $errs }
  ```
