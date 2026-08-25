# 通用 GitHub Release 发布工具
# 用法示例：
#   .\create-release.ps1 -Tag v1.0.8                          # 自动从 CHANGELOG 提取 1.0.8 段落到 Release Notes
#   .\create-release.ps1 -Tag v1.0.9 -Draft                   # 草稿
#   .\create-release.ps1 -Tag v1.1.0 -Repo owner/repo -ChangelogPath ..\other\CHANGELOG.md
# 说明：
#   - token 从 git 凭据管理器（credential manager）获取，只存内存不落盘
#   - 幂等：Release 已存在则 PATCH 更新，不存在则 POST 创建
#   - 必须有已推送的对应 tag，GitHub 会自动关联
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,            # 版本标签，如 v1.0.8 或 1.0.8（自动补 v 前缀）

    [string]$Repo,           # owner/repo；留空则从 git remote origin 解析

    [string]$ChangelogPath,  # CHANGELOG 路径；留空则默认 <脚本目录>/../libiao-copilot/CHANGELOG.md

    [switch]$Draft,

    [switch]$Prerelease
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

# ---------- 1. 规范化参数 ----------
$Tag = if ($Tag -notmatch '^v') { "v$Tag" } else { $Tag }
Write-Host "==> 目标标签: $Tag"

# ---------- 2. 解析仓库 ----------
if (-not $Repo) {
    # 自动探测 git 仓库：当前目录 → 脚本同级的 libiao-copilot → 脚本目录
    $candidates = @((Get-Location).Path, (Join-Path $PSScriptRoot '..'), (Join-Path $PSScriptRoot '..\libiao-copilot'), $PSScriptRoot)
    $remote = $null
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir '.git')) {
            $remote = git -C $dir remote get-url origin 2>$null
            if ($remote) { break }
        }
    }
    if (-not $remote) { throw '无法获取 git remote origin，请用 -Repo 手动指定' }
    $m = [regex]::Match($remote, 'github\.com[/:]([^/]+)/([^/]+?)(\.git)?$')
    if (-not $m.Success) { throw "无法从远程地址解析仓库: $remote，请用 -Repo 手动指定" }
    $Repo = "$($m.Groups[1].Value)/$($m.Groups[2].Value)"
}
Write-Host "==> 目标仓库: $Repo"

# ---------- 3. 从 CHANGELOG 提取版本段落 ----------
if (-not $ChangelogPath) {
    $changelogCandidates = @(
        (Join-Path $PSScriptRoot '..\CHANGELOG.md'),
        (Join-Path $PSScriptRoot '..\libiao-copilot\CHANGELOG.md')
    )
    foreach ($cand in $changelogCandidates) {
        if (Test-Path -LiteralPath $cand) {
            $ChangelogPath = $cand
            break
        }
    }
    if (-not $ChangelogPath) {
        $ChangelogPath = Join-Path $PSScriptRoot '..\CHANGELOG.md'
    }
}
if (-not (Test-Path $ChangelogPath)) { throw "CHANGELOG 不存在: $ChangelogPath" }
$changelog = Get-Content -Raw -Encoding UTF8 $ChangelogPath
$verNoV = $Tag -replace '^v', ''
$start = $changelog.IndexOf("## $verNoV")
if ($start -lt 0) { throw "CHANGELOG 中未找到段落: ## $verNoV" }
# 用行首 ^## 匹配下一节边界，避免匹配到 ### 子标题
$after = $changelog.Substring($start + $verNoV.Length + 3)
$m2 = [regex]::Match($after, '(?m)^## [^\#]')
$section = if ($m2.Success) {
    $changelog.Substring($start, $start + $verNoV.Length + 3 + $m2.Index - $start).Trim()
} else {
    $changelog.Substring($start).Trim()
}
if ($section.Length -eq 0) { throw 'CHANGELOG 段落为空，请检查格式' }
Write-Host "==> Release Notes 长度: $($section.Length) 字符"

# ---------- 4. 获取 token（git 凭据管理器，不落盘） ----------
# 注意：PowerShell 管道把字符串原样整行喂给原生命令，git 会报 "credential missing protocol field"；
# 必须用文件重定向按行喂标准输入
$tmp = New-TemporaryFile
Set-Content -Path $tmp -Value "protocol=https", "host=github.com", "" -Encoding ascii
try {
    $cred = cmd /c "type `"$tmp`" | git credential fill" 2>$null
} finally {
    Remove-Item $tmp -Force
}
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw '无法获取 GitHub token' }
Write-Host "==> 已获取凭据: $(( $cred | Where-Object { $_ -like 'username=*' }) -replace '^username=','')"

# ---------- 5. 创建或更新 Release ----------
$headers = @{ Authorization = "token $token"; 'User-Agent' = 'ps-release-api' }
$baseUri = "https://api.github.com/repos/$Repo/releases"
$payload = @{
    tag_name   = $Tag
    name       = $Tag
    body       = $section
    draft      = [bool]$Draft
    prerelease = [bool]$Prerelease
} | ConvertTo-Json

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

try {
    $resp = Invoke-RestMethod -Uri $baseUri -Method Post -Headers $headers -Body $bodyBytes -ContentType 'application/json; charset=utf-8'
    Write-Host "==> Release 创建成功: $($resp.html_url)  id=$($resp.id)" -ForegroundColor Green
} catch {
    $statusCode = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { 0 }
    if ($statusCode -eq 422 -or $statusCode -eq 400) {
        # 已存在 → PATCH 更新
        $existing = Invoke-RestMethod -Uri "$baseUri/tags/$Tag" -Headers $headers
        $patchBody = @{ name = $Tag; body = $section; draft = [bool]$Draft; prerelease = [bool]$Prerelease } | ConvertTo-Json
        $patchBytes = [System.Text.Encoding]::UTF8.GetBytes($patchBody)
        $resp = Invoke-RestMethod -Uri "$baseUri/$($existing.id)" -Method Patch -Headers $headers -Body $patchBytes -ContentType 'application/json; charset=utf-8'
        Write-Host "==> Release 已存在，已更新: $($resp.html_url)  id=$($resp.id)" -ForegroundColor Green
    } else {
        throw
    }
}
