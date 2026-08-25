---
name: extension-lifecycle
description: Libiao Copilot 插件的编译、自动化测试、打包构建、本地安全安装与 GitHub Release 发布工作流。当用户要求编译代码、运行测试、打包 VSIX、安装/更新插件到本地 VS Code、或者发布新版本 Release 时使用。
---

# Libiao Copilot 插件生命周期与构建安装技能 (Extension Lifecycle Skill)

本技能定义了 Libiao Copilot 插件从**源码编译**、**单元测试**、**VSIX 打包**、**本地一键安全安装**到 **GitHub Release 发布**的标准化严谨工作流。

---

## 🚨 绝对红线（违反必死，严格执行）

1. **工作区目录红线**：
   - 本工作空间根目录不是 Git 仓库！所有 `npm`、`git`、`npx` 等命令**必须在 `libiao-copilot/` 子目录下执行**。
2. **VSIX 打包源唯一性**：
   - 打包产物**全局唯一路径**为 `libiao-copilot/extension.vsix`。
   - 打包必须执行 `npm run build`（底层为 `vsce package -o extension.vsix`）。
   - **严禁添加 `--no-dependencies`**，否则会丢失 `@microsoft/tiktokenizer` 运行时依赖导致插件启动静默崩溃。
3. **本地安装唯一合法指令**：
   - **严禁直接裸敲 `code --install-extension`**！
   - 本地安装必须在仓库根目录执行（优先使用 PowerShell 7 `pwsh`）：
     ```powershell
     pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1
     ```
     （该脚本自带清理旧版本残留目录、自动配置 `%USERPROFILE%\.vscode\argv.json` 的 `enable-proposed-api` 权限、禁用上游冲突插件等全套防护逻辑）。
4. **版本号与 Git Tag 铁律**：
   - 未经特哥明确指令，**严禁私自修改 `package.json` 中的 `version` 字段**。
   - Git Tag 必须打**注解标签**：`git tag -a vX.Y.Z -m "..."`。
5. **测试铁律（“写了测试” $\neq$ “测过”）**：
   - 打包交付前**必须真实跑通 `npm test`**，全部用例 PASS 后方可打包分发。

---

## 🛠️ 标准工作流 SOP

### 场景 A：日常编译与代码检查
当用户要求“编译”、“检查语法”、“跑 lint”时：
```powershell
# 1. 确保在 libiao-copilot 目录下
cd d:\【00】工作空间\【0】代码\【08】AI\LibiaoCopilot\libiao-copilot

# 2. 执行编译与类型检查
npm run compile

# 3. (可选) 代码风格检查
npm run lint
```

---

### 场景 B：运行自动化测试
当用户要求“跑测试”、“验证测试用例”时：
```powershell
cd d:\【00】工作空间\【0】代码\【08】AI\LibiaoCopilot\libiao-copilot

# 执行完整编译并拉起 VS Code 宿主运行测试套件
npm test
```
* **排错要点**：若测试用例数量异常或怀疑有残留测试，先清理 `libiao-copilot/out/` 目录重新 `npm run compile` 再跑。

---

### 场景 C：端到端“打包并安装到本地”
当用户说“帮我打包安装”、“把刚才的改动装到本地”、“更新插件”时，**严格按以下 4 步顺序流水线执行**：

```powershell
# Step 1: 进入插件目录
cd d:\【00】工作空间\【0】代码\【08】AI\LibiaoCopilot\libiao-copilot

# Step 2: 编译与测试验证
npm run compile
npm test

# Step 3: 打包 VSIX（唯一输出路径为当前目录 extension.vsix，含 node_modules 依赖）
npm run build

# Step 4: 运行专属安装脚本（推荐 pwsh）
pwsh -ExecutionPolicy Bypass -File .\scripts\Install-LibiaoCopilot.ps1
```

* **执行完毕后提醒**：
  安装完成后，提醒用户：**“请完全退出 VS Code（关闭所有窗口）再重新打开，以让 argv.json 权限和新插件生效。”**

---

### 场景 D：GitHub Release 发布新版本
当特哥明确要求发布新版本（如 `v1.2.0`）时，严格遵循 **`github-release` 专项技能**：
1. 检查 `package.json` 的版本号与 CHANGELOG.md 是否已准备就绪。
2. 确保工作区干净且已推送到 `origin/main`。
3. 确认已创建注解 Tag 并推送到远程：
   ```powershell
   git tag -a vX.Y.Z -m "release: vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. 运行自动化 Release 脚本（脚本采用 UTF-8 字节流防乱码，自动提取 CHANGELOG 段落）：
   ```powershell
   pwsh -ExecutionPolicy Bypass -File .\scripts\create-release.ps1 -Tag vX.Y.Z
   ```
5. 使用 Node.js 验证线上 Release 页面与中文编码无乱码。
