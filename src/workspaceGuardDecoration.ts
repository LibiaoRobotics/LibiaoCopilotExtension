import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { readWorkspaceSettingsIntent } from "./workspaceGuard";

export interface DecorationRuleInfo {
	badge?: string;
	tooltip?: string;
	color?: vscode.ThemeColor;
}

/**
 * 纯逻辑函数：决议指定文件或目录的装饰器视觉属性（便于测试与隔离）
 */
export function resolveFileDecoration(
	targetFsPath: string,
	options: {
		workspaceRoot?: string;
		selectedProjectRoot?: string;
		ignoredRepositories?: Set<string>;
	}
): DecorationRuleInfo | undefined {
	const normalizedTarget = path.resolve(targetFsPath).toLowerCase();
	const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot).toLowerCase() : undefined;
	const selectedProjectRoot = options.selectedProjectRoot
		? path.resolve(options.selectedProjectRoot).toLowerCase()
		: undefined;
	const ignoredRepos = options.ignoredRepositories || new Set<string>();

	// 1. 目标核心工程目录本身
	if (selectedProjectRoot && normalizedTarget === selectedProjectRoot) {
		return {
			badge: "🏰",
			tooltip: "【核心开发工程】当前激活的目标项目，已配备 AI 工程防线",
			color: new vscode.ThemeColor("testing.iconPassed"),
		};
	}

	// 2. 只读参考工程目录（被 git.ignoredRepositories 排除的一级子目录）
	if (workspaceRoot) {
		const targetParent = path.dirname(normalizedTarget);
		const targetBaseName = path.basename(normalizedTarget);
		if (targetParent === workspaceRoot && ignoredRepos.has(targetBaseName)) {
			return {
				badge: "📖",
				tooltip: "【只读参考工程】已在 .vscode/settings.json (git.ignoredRepositories) 中忽略",
				color: new vscode.ThemeColor("disabledForeground"),
			};
		}
	}

	// 3. 目标工程内的 .github 及其关键资产
	if (selectedProjectRoot && (normalizedTarget.startsWith(selectedProjectRoot + path.sep) || normalizedTarget === selectedProjectRoot)) {
		const relative = path.relative(selectedProjectRoot, normalizedTarget).replace(/\\/g, "/");

		// .github 根目录
		if (relative === ".github") {
			return {
				badge: "AI",
				tooltip: "【AI 工程防线】包含项目指令总纲、模块化规约与工作流技能",
				color: new vscode.ThemeColor("charts.blue"),
			};
		}

		// .github/copilot-instructions.md
		if (relative === ".github/copilot-instructions.md") {
			return {
				badge: "纲",
				tooltip: "【项目指令总纲】随仓库流转的最高执行准则、操作授权与验证红线",
				color: new vscode.ThemeColor("charts.yellow"),
			};
		}

		// .github/instructions 目录及内部规约文件
		if (relative === ".github/instructions") {
			return {
				badge: "规",
				tooltip: "【模块化规约目录】按技术栈与文件路径精准匹配 (applyTo)",
				color: new vscode.ThemeColor("charts.cyan"),
			};
		}
		if (relative.startsWith(".github/instructions/") && relative.endsWith(".md")) {
			return {
				badge: "规",
				tooltip: "【模块化规约】随文件类型自动注入的语言/架构规约",
				color: new vscode.ThemeColor("charts.cyan"),
			};
		}

		// .github/skills 目录及内部技能
		if (relative === ".github/skills") {
			return {
				badge: "技",
				tooltip: "【场景化技能目录】包含标准三段式 SOP 与强制退出码核对闭环",
				color: new vscode.ThemeColor("charts.purple"),
			};
		}
		if (relative.startsWith(".github/skills/")) {
			const subParts = relative.split("/");
			// .github/skills/<skill-name> 子目录
			if (subParts.length === 3) {
				return {
					badge: "技",
					tooltip: `【场景技能】${subParts[2]} 标准化操作与验证 SOP`,
					color: new vscode.ThemeColor("charts.purple"),
				};
			}
			// .github/skills/<skill-name>/SKILL.md
			if (subParts.length === 4 && subParts[3].toLowerCase() === "skill.md") {
				return {
					badge: "SOP",
					tooltip: `【技能 SOP】${subParts[2]} 标准执行与验证闭环说明`,
					color: new vscode.ThemeColor("charts.purple"),
				};
			}
		}

		// .github/prompts 目录及内部提示词
		if (relative === ".github/prompts") {
			return {
				badge: "词",
				tooltip: "【提示词模板目录】高频研发动作的标准化 Prompt 资产",
				color: new vscode.ThemeColor("charts.green"),
			};
		}

		// .github/agents 目录及内部智能体
		if (relative === ".github/agents") {
			return {
				badge: "智",
				tooltip: "【专项智能体目录】隔离噪声报文的垂直场景 Agent",
				color: new vscode.ThemeColor("charts.orange"),
			};
		}
	}

	return undefined;
}

/**
 * 注册到 VS Code 的工程防线资源管理器修饰提供者
 */
export class WorkspaceGuardDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private static instance: WorkspaceGuardDecorationProvider | undefined;
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private currentSelectedProjectRoot: string | undefined;
	private disposables: vscode.Disposable[] = [];

	private constructor() {
		// 监听 .vscode/settings.json 变更，自动刷新装饰
		const watcher = vscode.workspace.createFileSystemWatcher("**/.vscode/settings.json");
		watcher.onDidChange(() => this.refresh());
		watcher.onDidCreate(() => this.refresh());
		watcher.onDidDelete(() => this.refresh());
		this.disposables.push(watcher);
	}

	public static register(context: vscode.ExtensionContext): WorkspaceGuardDecorationProvider {
		if (!WorkspaceGuardDecorationProvider.instance) {
			const provider = new WorkspaceGuardDecorationProvider();
			const registration = vscode.window.registerFileDecorationProvider(provider);
			context.subscriptions.push(provider, registration);
			WorkspaceGuardDecorationProvider.instance = provider;
		}
		return WorkspaceGuardDecorationProvider.instance;
	}

	public static getInstance(): WorkspaceGuardDecorationProvider | undefined {
		return WorkspaceGuardDecorationProvider.instance;
	}

	/**
	 * 更新当前选中的目标工程根目录，并触发装饰器全量刷新
	 */
	public setSelectedProjectRoot(projectRoot: string | undefined) {
		this.currentSelectedProjectRoot = projectRoot ? path.resolve(projectRoot) : undefined;
		this.refresh();
	}

	public getSelectedProjectRoot(): string | undefined {
		return this.currentSelectedProjectRoot;
	}

	public refresh() {
		this._onDidChangeFileDecorations.fire(undefined);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme !== "file") {
			return undefined;
		}

		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}

		const workspaceRoot = folders[0].uri.fsPath;
		const settingsIntent = readWorkspaceSettingsIntent(workspaceRoot);

		const rule = resolveFileDecoration(uri.fsPath, {
			workspaceRoot,
			selectedProjectRoot: this.currentSelectedProjectRoot,
			ignoredRepositories: settingsIntent.ignoredRepositories,
		});

		if (!rule) {
			return undefined;
		}

		const decoration = new vscode.FileDecoration(rule.badge, rule.tooltip, rule.color);
		return decoration;
	}

	dispose() {
		this._onDidChangeFileDecorations.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
		WorkspaceGuardDecorationProvider.instance = undefined;
	}
}
