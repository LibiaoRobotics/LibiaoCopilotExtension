---
name: github-release
description: 打注解标签（Annotated Git Tag）与 GitHub Release 自动化发布技能。当用户要求发布新版本 Release、打注解标签（git tag -a）、生成或同步 Release Notes、排查 Release 描述乱码、或推送版本标签到 GitHub 时使用。
---

# GitHub Release 发布与注解标签技能 (GitHub Release & Tag Skill)

本技能定义了 Libiao Copilot 项目在发布新版本时的标准化工作流，涵盖版本三要素核验、Git 注解标签创建、远程 Tag 推送、基于 `CHANGELOG.md` 自动生成 Release Notes、PowerShell 5.1 编码防损以及线上 Release 完整性核验。

---

## 🚨 核心避雷红线（违反必翻车）

1. **工作区目录红线**：
   - 本工作空间根目录不是 Git 仓库！所有 `git`、`powershell` 发布命令**必须在 `libiao-copilot/` 仓库目录下执行**。
2. **必须使用注解标签 (Annotated Tag)**：
   - 严禁打无信息的轻量标签（`git tag vX.Y.Z`）。
   - **必须**使用带消息的注解标签：`git tag -a vX.Y.Z -m "release: vX.Y.Z"`。
3. **版本号与权限铁律**：
   - 未经特哥明确指令，**严禁私自修改 `package.json` 中的 `version` 字段**。
   - 必须在特哥明确发出发布指令后，方可创建 Tag 和执行 Release。
4. **PowerShell 5.1 编码防乱码铁律（2026-08-25 事故血泪教训）**：
   - **脚本文件编码**：`scripts/create-release.ps1` 必须带 UTF-8 BOM（`0xEF, 0xBB, 0xBF`），防止 Windows 默认 GBK 导致脚本解析崩溃。
   - **HTTP 请求体编码**：Windows PowerShell 5.1 的 `Invoke-RestMethod` 在向 `-Body` 传入字符串时，默认按 ISO-8859-1 编码传输，会导致 Release 描述中的中文**全部变成问号 `?` 乱码**！
   - **防损标准**：请求体必须使用 `[System.Text.Encoding]::UTF8.GetBytes($payload)` 转换为 UTF-8 字节流，并显式指定 `-ContentType 'application/json; charset=utf-8'`。
5. **发布后真机闭环核验**：
   - 严禁“脚本跑完即认为成功”，必须通过 GitHub API 真实抓取线上 Release 的 `body` 内容，确认中文完整无乱码。

---

## 🛠️ 标准操作 SOP

### 第 1 步：发布前三要素检查
在执行发布前，逐一核实以下三项：
1. **`libiao-copilot/package.json`** 的 `version` 字段已更新为目标版本（如 `1.2.0`）。
2. **`libiao-copilot/CHANGELOG.md`** 顶部已有对应的版本段落 `## 1.2.0` 且详细列出新增、改进或修复项。
3. **代码已全部提交并推送**：
   ```powershell
   cd libiao-copilot
   git status
   git push origin main
   ```

---

### 第 2 步：创建注解 Tag 并推送到 GitHub
```powershell
cd libiao-copilot
# 创建注解标签
git tag -a vX.Y.Z -m "release: vX.Y.Z"

# 推送标签到远程
git push origin vX.Y.Z
```

---

### 第 3 步：执行自动化 Release 脚本
运行项目专用 Release 脚本，该脚本会自动：
1. 从 `CHANGELOG.md` 中截取对应版本的更新内容作为 Release Notes；
2. 从本地 Git 凭据管理器安全读取 GitHub Token（内存操作，不落盘）；
3. 调用 GitHub REST API 创建或更新 Release（幂等处理）。

```powershell
cd libiao-copilot
powershell -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z
```

* **特殊场景参数**：
  - 发布为草稿：`powershell -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z -Draft`
  - 发布为预发布版本：`powershell -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z -Prerelease`

---

### 第 4 步：验证线上 Release 状态与中文编码
使用 Node.js 脚本直接请求 GitHub API 进行真实验证，确保标题和正文中的中文无乱码：

```powershell
node -e "
fetch('https://api.github.com/repos/LibiaoRobotics/LibiaoCopilotExtension/releases/tags/vX.Y.Z', { headers: { 'User-Agent': 'node-verify' } })
  .then(r => r.json())
  .then(d => {
    console.log('Release 状态:', d.html_url);
    console.log('Release 正文预览:\n', d.body);
  });
"
```

---

## 🔧 常见故障排查 (Troubleshooting)

| 现象 | 根因 | 处置 SOP |
|---|---|---|
| Release 页面中文全是 `????` | PowerShell 5.1 `Invoke-RestMethod` 默认使用 ISO-8859-1 发送字符串 | 确保 `create-release.ps1` 采用 `[System.Text.Encoding]::UTF8.GetBytes()` 发送字节流，直接重新执行脚本（会自动 PATCH 修复线上内容）。 |
| 运行 `create-release.ps1` 报语法解析错误 | `.ps1` 脚本缺少 UTF-8 BOM，被 PowerShell 5.1 按系统 GBK 解析 | 使用 Node 脚本重新将 `.ps1` 文件以 UTF-8 BOM 格式写盘。 |
| 报 `无法获取 GitHub token` | 本地 Git 凭据管理器未缓存 GitHub 登录凭据 | 在当前终端执行 `git push` 或通过 Git Credential Manager 登录一次。 |
| 报 `CHANGELOG 中未找到段落` | CHANGELOG 中二级标题格式不匹配 | 检查 `CHANGELOG.md` 中是否包含标准的 `## X.Y.Z` 标题格式（注意不带 `v`）。 |
