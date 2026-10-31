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

## 3. 本地安装与版本一致性
- `Install-LibiaoCopilot.ps1` 对 `%USERPROFILE%\.vscode\extensions` 下的多版本目录只**检测并警告**，**不自动删除**旧版本。
- 因此「脚本退出码 0」≠「新版已生效」：必须提醒用户完全退出 VS Code 后手动删除旧版本目录，否则验收会看到旧版本行为。
- 本地安装只能走 `pwsh -File .\scripts\Install-LibiaoCopilot.ps1`，禁用 `code --install-extension`。

## 4. 打包与版本号
- 打包统一为 `npm run build`（保留运行时依赖），严禁加 `--no-dependencies`。
- `package-lock.json` 的 `version` 字段长期滞后（如 1.1.1 而 `package.json` 为 1.3.x），发版时不要误改它。

## 5. 工具侧执行注意事项
- 本机 pwsh 终面对多行命令（换行拼接）不可靠：只执行首行或只回显片段。用单行 `;` 串联，或写 `.ps1` 再 `pwsh -File` 执行。
