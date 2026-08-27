import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface PowerShellStatus {
	installed: boolean;
	version: string;
	executablePath: string;
	isDefaultTerminalProfile: boolean;
	platform: string;
}

/**
 * 获取 Windows 下 PowerShell 7 的常见默认安装路径
 */
export function getStandardWindowsPwshPaths(): string[] {
	const paths: string[] = [];
	const programFiles = process.env.ProgramFiles || "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA || "";

	paths.push(
		path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
		path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
		path.join(programFilesX86, "PowerShell", "7", "pwsh.exe")
	);

	if (localAppData) {
		paths.push(
			path.join(localAppData, "Microsoft", "PowerShell", "7", "pwsh.exe"),
			path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe")
		);
	}
	return paths;
}

/**
 * 从 pwsh 输出中解析版本号（如 7.6.5, 7.4.2 等）
 */
export function parsePowerShellVersion(output: string): string | null {
	if (!output || typeof output !== "string") {
		return null;
	}
	const trimmed = output.trim();
	const match = trimmed.match(/\b(7\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)\b/i);
	return match ? match[1] : null;
}

/**
 * 检查当前 VS Code 是否已将 PowerShell 设置为默认终端 Profile
 */
export function isPowerShellDefaultProfile(): boolean {
	const config = vscode.workspace.getConfiguration("terminal.integrated");
	if (process.platform === "win32") {
		const defaultProfile = config.get<string>("defaultProfile.windows");
		return defaultProfile === "PowerShell";
	} else if (process.platform === "darwin") {
		const defaultProfile = config.get<string>("defaultProfile.osx");
		return defaultProfile === "pwsh" || defaultProfile === "PowerShell";
	} else {
		const defaultProfile = config.get<string>("defaultProfile.linux");
		return defaultProfile === "pwsh" || defaultProfile === "PowerShell";
	}
}

/**
 * 将 VS Code 默认终端设置为 PowerShell
 */
export async function setPowerShellAsDefaultProfile(): Promise<boolean> {
	try {
		const config = vscode.workspace.getConfiguration("terminal.integrated");
		if (process.platform === "win32") {
			await config.update("defaultProfile.windows", "PowerShell", vscode.ConfigurationTarget.Global);
		} else if (process.platform === "darwin") {
			await config.update("defaultProfile.osx", "pwsh", vscode.ConfigurationTarget.Global);
		} else {
			await config.update("defaultProfile.linux", "pwsh", vscode.ConfigurationTarget.Global);
		}
		return true;
	} catch (err) {
		console.error("[libiaoCopilot] Failed to set default terminal profile", err);
		return false;
	}
}

/**
 * 生成自动安装 PowerShell 7 的 PowerShell 复合命令（优先 winget 静默安装，兜底微软官方脚本）
 */
export function getPowerShellInstallCommand(): string {
	return [
		`Write-Host "=================================================" -ForegroundColor Cyan`,
		`Write-Host "  Libiao Copilot - 正在自动下载并安装 PowerShell 7" -ForegroundColor Cyan`,
		`Write-Host "=================================================" -ForegroundColor Cyan`,
		`$installed = $false`,
		`if (Get-Command winget -ErrorAction SilentlyContinue) {`,
		`    Write-Host ">>> 检测到 winget，正在通过官方源执行安装..." -ForegroundColor Green`,
		`    winget install --id Microsoft.PowerShell --source winget --accept-source-agreements --accept-package-agreements`,
		`    if ($LASTEXITCODE -eq 0) { $installed = $true }`,
		`}`,
		`if (-not $installed) {`,
		`    Write-Host ">>> 正在通过微软官方脚本安装 PowerShell 7..." -ForegroundColor Yellow`,
		`    & { $(irm https://aka.ms/install-powershell.ps1) } -UseMSI`,
		`}`,
		`Write-Host "\`n=== 安装流程执行完成！请重启 VS Code 或新建终端以生效 ===" -ForegroundColor Green`,
	].join("; ");
}

/**
 * 在 VS Code 终端中唤起 PowerShell 7 自动安装
 */
export async function launchPowerShellInstaller(): Promise<void> {
	const terminalName = "PowerShell 7 Installer";
	let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
	if (!terminal) {
		terminal = vscode.window.createTerminal({ name: terminalName });
	}
	terminal.show();
	const command = getPowerShellInstallCommand();
	terminal.sendText(command);
	vscode.window.showInformationMessage(
		"已在专用终端中启动 PowerShell 7 自动安装程序，请关注终端输出并在提示时确认安装。"
	);
}

/**
 * 打开 PowerShell 官方安装文档页面
 */
export async function openPowerShellOfficialDocs(): Promise<void> {
	await vscode.env.openExternal(
		vscode.Uri.parse("https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows")
	);
}

/**
 * 探测本机 PowerShell 7 的安装与运行状态
 */
export async function getPowerShellStatus(): Promise<PowerShellStatus> {
	const platform = process.platform;
	const isDefaultTerminalProfile = isPowerShellDefaultProfile();

	// 1. 尝试从 PATH 中直接调用 pwsh
	try {
		const { stdout } = await execFileAsync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
			{
				timeout: 3000,
				windowsHide: true,
			}
		);
		const version = parsePowerShellVersion(stdout) || stdout.trim();
		if (version) {
			let executablePath = "pwsh";
			try {
				const whereCmd = platform === "win32" ? "where.exe" : "which";
				const { stdout: whereOut } = await execFileAsync(whereCmd, ["pwsh"], {
					timeout: 2000,
					windowsHide: true,
				});
				const firstLine = whereOut.trim().split(/\r?\n/)[0];
				if (firstLine) {
					executablePath = firstLine.trim();
				}
			} catch {
				// 保留 pwsh
			}
			return {
				installed: true,
				version,
				executablePath,
				isDefaultTerminalProfile,
				platform,
			};
		}
	} catch {
		// PATH 中未找到或调用超时，继续探测
	}

	// 2. Windows 平台下检索常见安装路径
	if (platform === "win32") {
		const candidates = getStandardWindowsPwshPaths();
		for (const exePath of candidates) {
			try {
				if (fs.existsSync(exePath)) {
					const { stdout } = await execFileAsync(
						exePath,
						["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
						{
							timeout: 3000,
							windowsHide: true,
						}
					);
					const version = parsePowerShellVersion(stdout) || stdout.trim();
					if (version) {
						return {
							installed: true,
							version,
							executablePath: exePath,
							isDefaultTerminalProfile,
							platform,
						};
					}
				}
			} catch {
				// 继续检查下一个候选路径
			}
		}
	}

	return {
		installed: false,
		version: "",
		executablePath: "",
		isDefaultTerminalProfile,
		platform,
	};
}

export const POWERSHELL_PROMPT_SUPPRESS_KEY = "libiaoCopilot.suppressPowerShellPrompt";

/**
 * 启动后检查 PowerShell 7 安装及默认终端状态，并在必要时弹出操作提示（仅限 Windows 平台）
 */
export async function promptPowerShellSetupIfNeeded(
	globalState: vscode.Memento,
	overridePlatform?: string,
	mockShowInfo?: (message: string, ...items: string[]) => Thenable<string | undefined>
): Promise<"installed_prompted" | "default_profile_prompted" | "skipped" | "none"> {
	const platform = overridePlatform ?? process.platform;
	if (platform !== "win32") {
		return "none";
	}

	const isSuppressed = globalState.get<boolean>(POWERSHELL_PROMPT_SUPPRESS_KEY, false);
	if (isSuppressed) {
		return "skipped";
	}

	const status = await getPowerShellStatus();
	const showInfo = mockShowInfo ?? vscode.window.showInformationMessage;

	if (!status.installed) {
		const installBtn = "🚀 一键安装";
		const suppressBtn = "不再提示";
		const selection = await showInfo(
			"Libiao Copilot: 检测到当前系统尚未安装 PowerShell 7 (pwsh)。建议安装以获得最佳终端兼容性与运行速度。",
			installBtn,
			suppressBtn
		);

		if (selection === installBtn) {
			await launchPowerShellInstaller();
		} else if (selection === suppressBtn) {
			await globalState.update(POWERSHELL_PROMPT_SUPPRESS_KEY, true);
		}
		return "installed_prompted";
	}

	if (!status.isDefaultTerminalProfile) {
		const setDefaultBtn = "⚡ 设为默认";
		const suppressBtn = "不再提示";
		const selection = await showInfo(
			"Libiao Copilot: 检测到已安装 PowerShell 7，建议将其设为 VS Code 默认集成终端以避免脚本编码问题。",
			setDefaultBtn,
			suppressBtn
		);

		if (selection === setDefaultBtn) {
			const success = await setPowerShellAsDefaultProfile();
			if (success) {
				void vscode.window.showInformationMessage("已成功将 PowerShell 设置为 VS Code 默认集成终端。新建终端即可生效。");
			}
		} else if (selection === suppressBtn) {
			await globalState.update(POWERSHELL_PROMPT_SUPPRESS_KEY, true);
		}
		return "default_profile_prompted";
	}

	return "none";
}

/**
 * 在插件激活后延时（默认 1 分钟）调度 PowerShell 7 状态检查
 */
export function schedulePowerShellPrompt(
	context: vscode.ExtensionContext,
	delayMs = 60000
): vscode.Disposable {
	const timer = setTimeout(async () => {
		try {
			await promptPowerShellSetupIfNeeded(context.globalState);
		} catch (err) {
			console.error("[libiaoCopilot] Failed during PowerShell startup prompt check", err);
		}
	}, delayMs);

	const disposable = new vscode.Disposable(() => clearTimeout(timer));
	context.subscriptions.push(disposable);
	return disposable;
}

