---
description: PowerShell 7 运行环境标准、UTF-8 BOM 编码与脚本规范
applyTo: "**/*.{ps1,bat,cmd,json}"
---

# PowerShell 运行环境与脚本规约 (PowerShell Environment & Scripts)

## 1. PowerShell 7 (`pwsh`) 统一规范
- 全套脚本、VS Code Tasks 及 CLI 指令**统一使用 `pwsh`（PowerShell 7+）**，严禁使用旧版 `powershell.exe`（5.1）。
- 脚本入口（`Install-LibiaoCopilot.ps1`、`create-release.ps1`、`Install-LibiaoCopilot.bat`）内置探测逻辑：在 5.1 启动且系统装有 `pwsh` 时自动重新调度至 `pwsh` 执行。

## 2. 文件编码与防损红线
- 所有 `.ps1` 脚本保存时**必须包含 UTF-8 BOM 头（`0xEF, 0xBB, 0xBF`）**，防止 Windows 默认 GBK 导致解析崩溃。
- 保存 `.ps1` 脚本后，必须通过 PowerShell AST 语法解析器检验合法性：
  ```powershell
  $errs = @(); [System.Management.Automation.Language.Parser]::ParseFile('.\script.ps1', [ref]$null, [ref]$errs) | Out-Null; if ($errs.Count -eq 0) { Write-Host 'Syntax OK' } else { $errs }
  ```
- 涉及 Emoji（👁️ / 🖼️ / ⚠️）的写入操作，必须采用 Unicode 码点转义写入并核验。
