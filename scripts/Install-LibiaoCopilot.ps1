#Requires -Version 5.1
<#
.SYNOPSIS
    Libiao Copilot VSIX 一键安装脚本（Windows）。

.DESCRIPTION
    完成三件事：
      1. 安装 libiao-copilot\extension.vsix（npm run build 的打包产物）到 VS Code
      2. 自动在 %USERPROFILE%\.vscode\argv.json 中配置 enable-proposed-api
         （本扩展使用 VS Code 提案 API，VSIX 安装必须配置此项才能激活）
      3. 若检测到上游插件 johnny-zhao.oai-compatible-copilot 已安装，将其禁用
         （两者同时启用会导致模型列表重复；仅禁用不卸载，可在扩展面板恢复）

    脚本是幂等的：重复运行不会重复配置；修改 argv.json 前会自动备份。

    安装包唯一来源：libiao-copilot\extension.vsix。请勿在 scripts 目录放置
    其他 .vsix 副本，防止安装到旧包。

    安装完成后，必须【完全退出 VS Code（关闭所有窗口）再重新打开】，
    “重新加载窗口”无效，argv.json 只在启动时读取。

.EXAMPLE
    方式一（推荐）：pwsh -ExecutionPolicy Bypass -File .\Install-LibiaoCopilot.ps1
    方式二：右键本文件 → “使用 PowerShell 运行”

.PARAMETER VsixPath
    可选。指定 .vsix 文件路径。默认使用打包产物 libiao-copilot\extension.vsix。
#>
param(
    [string]$VsixPath
)

# 确保在 PowerShell 7 (pwsh) 下运行，若在 Windows PowerShell 5.1 启动且系统装有 pwsh 则自动切换
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwshCmd) {
        Write-Host ">>> 检测到当前为 Windows PowerShell $($PSVersionTable.PSVersion)，正在自动切换至 PowerShell 7 (pwsh) 执行..." -ForegroundColor Cyan
        & $pwshCmd.Source -NoLogo -ExecutionPolicy Bypass -File $PSCommandPath @args
        exit $LASTEXITCODE
    }
}

$ErrorActionPreference = 'Stop'
$ExtensionId = 'libiaorobot.libiao-copilot'
# 上游插件 ID：同时启用会导致模型列表重复，需禁用
$UpstreamExtensionId = 'johnny-zhao.oai-compatible-copilot'

# 统一退出点：直接退出，不停顿等待按键（脚本适合命令行/自动化调用）
function Stop-Script {
    param([int]$Code = 0)
    exit $Code
}

Write-Host ''
Write-Host '========== Libiao Copilot 一键安装 ==========' -ForegroundColor Cyan
Write-Host ''

# ---------- 第 0 步：定位 VSIX ----------
# 唯一来源：libiao-copilot\extension.vsix（npm run build 的打包产物）。
# 脚本目录（scripts）不再维护任何 vsix 副本，避免装了旧包、改了没生效的问题。
if (-not $VsixPath) {
    $candidates = @(
        (Join-Path $PSScriptRoot '..\extension.vsix'),
        (Join-Path $PSScriptRoot '..\libiao-copilot\extension.vsix')
    )
    foreach ($cand in $candidates) {
        if (Test-Path -LiteralPath $cand) {
            $VsixPath = $cand
            break
        }
    }
    if (-not $VsixPath) {
        $VsixPath = Join-Path $PSScriptRoot '..\extension.vsix'
    }
}
$VsixPath = [System.IO.Path]::GetFullPath($VsixPath)
if (-not (Test-Path -LiteralPath $VsixPath)) {
    Write-Host "【失败】找不到打包产物：$VsixPath" -ForegroundColor Red
    Write-Host "      请先执行 npm run build（在 libiao-copilot 目录）生成 extension.vsix，" -ForegroundColor Yellow
    Write-Host "      或使用 -VsixPath 参数手动指定 .vsix 文件。" -ForegroundColor Yellow
    Stop-Script 1
}
Write-Host "[1/4] 准备安装扩展：$VsixPath" -ForegroundColor Cyan

# ---------- 第 1 步：安装扩展 ----------
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCmd) {
    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
    if (Test-Path $fallback) {
        $codeCmd = $fallback
    } else {
        Write-Host "【失败】找不到 code 命令。请确认已安装 VS Code，并在安装时勾选了“添加到 PATH”，或手动将 bin 目录加入 PATH。" -ForegroundColor Red
        Stop-Script 1
    }
}

# 过滤 VS Code CLI 的 Node.js 弃用警告（无害噪音，避免误导用户）。
# 注意：$ErrorActionPreference='Stop' 会把原生命令的 stderr 升级成终止性错误，
# 所以调用期间临时切到 Continue，先收集全部输出再过滤显示；真实错误照常保留
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$installOutput = & $codeCmd --install-extension $VsixPath --force 2>&1
$ErrorActionPreference = $prevEap
$installOutput |
    Where-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            "$_" -notmatch '(?s)DeprecationWarning|trace-deprecation|\(node:\d+\)|WHATWG URL API'
        } else {
            $true
        }
    } | ForEach-Object { Write-Host "$_" }
if ($LASTEXITCODE -ne 0) {
    Write-Host "【失败】扩展安装失败（退出码 $LASTEXITCODE）。" -ForegroundColor Red
    Stop-Script 1
}
Write-Host "      扩展安装成功。" -ForegroundColor Green

# ---------- 第 2 步：配置 enable-proposed-api ----------
Write-Host "[2/4] 配置提案 API 权限（argv.json）" -ForegroundColor Cyan
$argvPath = Join-Path $env:USERPROFILE '.vscode\argv.json'
if (-not (Test-Path $argvPath)) {
    Write-Host "【失败】找不到 $argvPath。请确认已安装 VS Code 并至少启动过一次。" -ForegroundColor Red
    Stop-Script 1
}

$original = Get-Content -LiteralPath $argvPath -Raw

if (($original -match '"enable-proposed-api"') -and ($original -match [regex]::Escape($ExtensionId))) {
    Write-Host "      已配置过，跳过。" -ForegroundColor Green
} else {
    # 备份
    $backupPath = "$argvPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $argvPath -Destination $backupPath
    Write-Host "      已备份原文件：$backupPath"

    if ($original -match '"enable-proposed-api"') {
        # 已有 enable-proposed-api 数组但缺我们的扩展 ID：把 ID 插进数组开头
        $updated = [regex]::Replace(
            $original,
            '("enable-proposed-api"\s*:\s*\[)',
            "`$1`"$ExtensionId`", "
        )
    } else {
        # 完全没有该配置：在最后一个 } 之前追加
        $lastBrace = $original.LastIndexOf('}')
        if ($lastBrace -lt 0) {
            Write-Host "【失败】argv.json 内容异常（找不到 }），请人工检查。" -ForegroundColor Red
            Stop-Script 1
        }
        $head = $original.Substring(0, $lastBrace).TrimEnd()
        $comma = if ($head.EndsWith('{')) { '' } else { ',' }
        $updated = $head + $comma + [Environment]::NewLine `
            + "`t`"enable-proposed-api`": [`"$ExtensionId`"]" + [Environment]::NewLine `
            + $original.Substring($lastBrace)
    }

    # 写回（UTF-8 无 BOM，与 VS Code 默认保存一致）
    [System.IO.File]::WriteAllText($argvPath, $updated, [System.Text.UTF8Encoding]::new($false))
    Write-Host "      配置完成。" -ForegroundColor Green
}

# ---------- 第 3 步：禁用上游插件（若已安装） ----------
# 用扩展目录检查代替 code --list-extensions，避免额外启动 VS Code 进程弹窗
Write-Host "[3/4] 检查上游插件（避免模型列表重复）" -ForegroundColor Cyan
$extRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
$upstreamDir = Get-ChildItem -LiteralPath $extRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$UpstreamExtensionId-*" } | Select-Object -First 1

if ($upstreamDir) {
    $prevEap3 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $disableOutput = & $codeCmd --disable-extension $UpstreamExtensionId 2>&1
    $ErrorActionPreference = $prevEap3
    Write-Host "      检测到已安装上游插件 $UpstreamExtensionId，已将其禁用。" -ForegroundColor Yellow
    Write-Host "      （两个插件同时启用会导致模型列表重复。如需恢复，可在扩展面板手动启用。）" -ForegroundColor DarkGray
} else {
    Write-Host "      未检测到上游插件，跳过。" -ForegroundColor Green
}

# ---------- 第 4 步：确认安装结果（纯目录检查，不启动 VS Code） ----------
# 版本号回退教训（2026-08-20）：code --install-extension 不会删除旧版本目录。
# 版本号回退（如 1.0.7 -> 1.0.6）时新旧目录并存，VS Code 启动按版本号取最高加载，
# 旧目录（1.0.7）反而压过新装的 1.0.6，导致"改了没生效"。因此必须检测多版本并存并警告。
Write-Host "[4/4] 确认安装结果" -ForegroundColor Cyan
$ourDirs = Get-ChildItem -LiteralPath $extRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$ExtensionId-*" } |
    Sort-Object Name -Descending
$ourDir = $ourDirs | Select-Object -First 1
if ($ourDir) {
    Write-Host "      已安装：$($ourDir.Name)" -ForegroundColor Green
    if ($ourDirs.Count -gt 1) {
        Write-Host "      【警告】检测到多个版本并存，VS Code 可能加载旧版本！" -ForegroundColor Red
        $ourDirs | ForEach-Object { Write-Host "        - $($_.Name)" -ForegroundColor DarkGray }
        Write-Host "      请完全退出 VS Code 后，删除除最新版本外的旧目录（位于 $extRoot），" -ForegroundColor Yellow
        Write-Host "      再重新打开 VS Code 验收。" -ForegroundColor Yellow
    }
} else {
    Write-Host "      【警告】未在 $extRoot 中找到扩展目录，请打开 VS Code 扩展面板人工确认。" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '========== 安装完成 ==========' -ForegroundColor Green
Write-Host '接下来请手动操作：' -ForegroundColor Yellow
Write-Host '  1. 完全退出 VS Code（关闭所有窗口）'
Write-Host '  2. 重新打开 VS Code'
Write-Host '  3. 设置 libiaoCopilot.baseUrl 为公司网关地址'
Write-Host '  4. Ctrl+Shift+P → “Libiao Copilot: 设置 API Key” 输入个人密钥'
Write-Host '  5. 打开 Copilot Chat，在模型选择器中选择 Libiao Copilot 的模型'

Stop-Script 0
