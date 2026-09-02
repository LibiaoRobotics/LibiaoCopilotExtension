import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface InstructionsStats {
	lineCount: number;
	charCount: number;
}

export interface ProjectFolderCandidate {
	fsPath: string;
	name: string;
	score: number;
	isWorkspaceRoot: boolean;
	hasDotGithub: boolean;
	hasInstructions: boolean;
	detectedStacks: string[];
}

export interface WorkspaceGuardStatus {
	hasWorkspace: boolean;
	workspaceRoot?: string;
	workspaceName?: string;
	selectedProjectRoot?: string;
	selectedProjectName?: string;
	projectCandidates: ProjectFolderCandidate[];
	detectedStacks: string[];
	dotGithubExists: boolean;
	hasInstructions: boolean;
	instructionsPath?: string;
	instructionsStats?: InstructionsStats;
	instructionFiles: string[];
	skills: string[];
	prompts: string[];
	agents: string[];
	defenseLevel: "none" | "basic" | "deep";
}

/**
 * 支持的技术栈类型标识
 */
export type SupportedStack = "typescript" | "csharp" | "python" | "cpp" | "java";

export interface StackOption {
	id: SupportedStack;
	name: string;
	fileName: string;
	applyPattern: string;
}

export const SUPPORTED_STACKS: StackOption[] = [
	{
		id: "typescript",
		name: "TypeScript / JavaScript",
		fileName: "typescript.instructions.md",
		applyPattern: "**/*.{ts,tsx,js,jsx}",
	},
	{
		id: "csharp",
		name: "C# / .NET",
		fileName: "csharp.instructions.md",
		applyPattern: "**/*.{cs,csproj}",
	},
	{
		id: "python",
		name: "Python",
		fileName: "python.instructions.md",
		applyPattern: "**/*.py",
	},
	{
		id: "cpp",
		name: "C / C++",
		fileName: "cpp.instructions.md",
		applyPattern: "**/*.{c,cpp,cc,cxx,h,hpp,hxx}",
	},
	{
		id: "java",
		name: "Java",
		fileName: "java.instructions.md",
		applyPattern: "**/*.java",
	},
];

const IGNORED_SCAN_FOLDERS = new Set([
	".git",
	".github",
	".vscode",
	".idea",
	"node_modules",
	"dist",
	"out",
	"build",
	"target",
	"bin",
	"obj",
	".venv",
	"venv",
	"__pycache__",
]);

/**
 * 嗅探目录下的技术栈特征文件
 */
export function detectStacksInDir(dirPath: string): string[] {
	const detected: string[] = [];
	try {
		if (!fs.existsSync(dirPath)) {
			return detected;
		}

		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		const fileNames = new Set<string>();
		let hasCsProjOrSln = false;
		let hasCppSource = false;

		for (const entry of entries) {
			const name = entry.name.toLowerCase();
			fileNames.add(name);
			if (name.endsWith(".csproj") || name.endsWith(".sln")) {
				hasCsProjOrSln = true;
			}
			if (
				name.endsWith(".cpp") ||
				name.endsWith(".c") ||
				name.endsWith(".cc") ||
				name.endsWith(".cxx") ||
				name.endsWith(".hpp") ||
				name.endsWith(".h")
			) {
				hasCppSource = true;
			}
		}

		// TypeScript / JavaScript
		if (
			fileNames.has("package.json") ||
			fileNames.has("tsconfig.json") ||
			fileNames.has("jsconfig.json")
		) {
			detected.push("typescript");
		}

		// C# / .NET
		if (
			hasCsProjOrSln ||
			fileNames.has("directory.build.props") ||
			fileNames.has("global.json")
		) {
			detected.push("csharp");
		}

		// Python
		if (
			fileNames.has("pyproject.toml") ||
			fileNames.has("requirements.txt") ||
			fileNames.has("pipfile") ||
			fileNames.has("setup.py") ||
			fileNames.has("poetry.lock")
		) {
			detected.push("python");
		}

		// C / C++
		if (
			hasCppSource ||
			fileNames.has("cmakelists.txt") ||
			fileNames.has("makefile") ||
			fileNames.has("conanfile.txt") ||
			fileNames.has("conanfile.py") ||
			fileNames.has("meson.build")
		) {
			detected.push("cpp");
		}

		// Java
		if (
			fileNames.has("pom.xml") ||
			fileNames.has("build.gradle") ||
			fileNames.has("build.gradle.kts") ||
			fileNames.has("settings.gradle") ||
			fileNames.has("mvnw") ||
			fileNames.has("gradlew")
		) {
			detected.push("java");
		}
	} catch (err) {
		console.error("[WorkspaceGuard] detectStacksInDir error:", err);
	}
	return detected;
}

export interface WorkspaceSettingsIntent {
	ignoredRepositories: Set<string>;
	promptTargetFolders: Set<string>;
}

/**
 * 解析工作区根目录下 .vscode/settings.json 中的关键配置意图：
 * 1. git.ignoredRepositories: 用户主动忽略的辅助/只读仓库列表（直接排除或强降权）
 * 2. chat.promptFilesLocations: 用户明确启用的提示词目录（正向提取所归属的目标子工程，最高置信度加分）
 */
export function readWorkspaceSettingsIntent(workspaceRoot: string): WorkspaceSettingsIntent {
	const ignoredRepositories = new Set<string>();
	const promptTargetFolders = new Set<string>();

	const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		return { ignoredRepositories, promptTargetFolders };
	}

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		// 移除 json 中的注释（防止包含注释的 settings.json 解析失败）
		const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		const json = JSON.parse(cleaned);

		// 1. 负向排除：git.ignoredRepositories
		if (Array.isArray(json["git.ignoredRepositories"])) {
			for (const repo of json["git.ignoredRepositories"]) {
				if (typeof repo === "string" && repo.trim()) {
					ignoredRepositories.add(repo.trim().toLowerCase());
				}
			}
		}

		// 2. 正向强化：chat.promptFilesLocations
		if (json["chat.promptFilesLocations"] && typeof json["chat.promptFilesLocations"] === "object") {
			for (const [locationPath, enabled] of Object.entries(json["chat.promptFilesLocations"])) {
				if (enabled) {
					// 例如: "libiao-copilot/.github/prompts" -> 提取第一段工程目录 "libiao-copilot"
					const normalized = locationPath.replace(/\\/g, "/").trim();
					const parts = normalized.split("/").filter(Boolean);
					if (parts.length > 0) {
						// 若是以相对路径指定，第一段通常即子工程名
						promptTargetFolders.add(parts[0].toLowerCase());
					}
				}
			}
		}
	} catch (err) {
		console.error("[WorkspaceGuard] readWorkspaceSettingsIntent error:", err);
	}

	return { ignoredRepositories, promptTargetFolders };
}

/**
 * 评估一个目录作为开发工程的评分
 */
export function scoreProjectDir(dirPath: string): { score: number; stacks: string[]; hasDotGithub: boolean; hasInstructions: boolean } {
	let score = 0;
	let hasDotGithub = false;
	let hasInstructions = false;

	if (!fs.existsSync(dirPath)) {
		return { score: 0, stacks: [], hasDotGithub: false, hasInstructions: false };
	}

	const stacks = detectStacksInDir(dirPath);
	score += stacks.length * 5;

	const dotGithub = path.join(dirPath, ".github");
	if (fs.existsSync(dotGithub) && fs.statSync(dotGithub).isDirectory()) {
		hasDotGithub = true;
		score += 10;
		const instructions = path.join(dotGithub, "copilot-instructions.md");
		if (fs.existsSync(instructions) && fs.statSync(instructions).isFile()) {
			hasInstructions = true;
			score += 15;
		}
	}

	try {
		const files = fs.readdirSync(dirPath).map((f) => f.toLowerCase());
		if (files.includes("agents.md")) {
			score += 5;
		}
		if (files.includes("readme.md")) {
			score += 2;
		}
	} catch {
		// ignore
	}

	return { score, stacks, hasDotGithub, hasInstructions };
}

/**
 * 发现工作区内的候选项目工程目录
 */
export function discoverProjectCandidates(workspaceRoot: string): ProjectFolderCandidate[] {
	const candidates: ProjectFolderCandidate[] = [];
	if (!fs.existsSync(workspaceRoot)) {
		return candidates;
	}

	// 读取 .vscode/settings.json 中的权威用户意图
	const settingsIntent = readWorkspaceSettingsIntent(workspaceRoot);

	// 1. 工作区根目录自身作为候选
	const rootAssessment = scoreProjectDir(workspaceRoot);
	candidates.push({
		fsPath: workspaceRoot,
		name: path.basename(workspaceRoot) || workspaceRoot,
		score: rootAssessment.score,
		isWorkspaceRoot: true,
		hasDotGithub: rootAssessment.hasDotGithub,
		hasInstructions: rootAssessment.hasInstructions,
		detectedStacks: rootAssessment.stacks,
	});

	// 2. 扫描一级子目录
	try {
		const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const folderName = entry.name;
			const lowerName = folderName.toLowerCase();

			// 排除常规非工程系统目录
			if (folderName.startsWith(".") || IGNORED_SCAN_FOLDERS.has(lowerName)) {
				continue;
			}

			// 负向权威排除：命中 git.ignoredRepositories 的辅助/参考/只读仓库，直接剔除候选
			if (settingsIntent.ignoredRepositories.has(lowerName)) {
				continue;
			}

			const subPath = path.join(workspaceRoot, folderName);
			const assessment = scoreProjectDir(subPath);
			let finalScore = assessment.score;

			// 正向权威加权：若该子工程被 chat.promptFilesLocations 显式指定，赋予超高置信度加分 (+50)
			if (settingsIntent.promptTargetFolders.has(lowerName)) {
				finalScore += 50;
			}

			// 若子目录具有特征或包含规约/代码，则纳入候选列表
			if (finalScore > 0 || assessment.stacks.length > 0 || assessment.hasDotGithub) {
				candidates.push({
					fsPath: subPath,
					name: folderName,
					score: finalScore,
					isWorkspaceRoot: false,
					hasDotGithub: assessment.hasDotGithub,
					hasInstructions: assessment.hasInstructions,
					detectedStacks: assessment.stacks,
				});
			}
		}
	} catch (err) {
		console.error("[WorkspaceGuard] discoverProjectCandidates error:", err);
	}

	// 排序：先按分数降序；分数相同时非根目录优先（子工程更具体），再按名称排序
	candidates.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (a.isWorkspaceRoot !== b.isWorkspaceRoot) {
			return a.isWorkspaceRoot ? 1 : -1;
		}
		return a.name.localeCompare(b.name);
	});

	return candidates;
}

/**
 * 依据当前活动编辑器文件向上反向推导最接近的项目工程目录
 */
export function findProjectRootFromActiveFile(activeFilePath: string, workspaceRoot: string): string | undefined {
	try {
		let currentDir = path.dirname(activeFilePath);
		const normalizedRoot = path.resolve(workspaceRoot).toLowerCase();

		while (true) {
			const normalizedCurrent = path.resolve(currentDir).toLowerCase();
			if (!normalizedCurrent.startsWith(normalizedRoot)) {
				break;
			}

			// 检查当前层级是否是项目边界
			const assessment = scoreProjectDir(currentDir);
			if (assessment.stacks.length > 0 || assessment.hasDotGithub) {
				return currentDir;
			}

			if (normalizedCurrent === normalizedRoot) {
				break;
			}

			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) {
				break;
			}
			currentDir = parentDir;
		}
	} catch (err) {
		console.error("[WorkspaceGuard] findProjectRootFromActiveFile error:", err);
	}
	return undefined;
}

/**
 * 决议最终的目标项目目录
 */
export function resolveTargetProjectRoot(
	workspaceRoot: string,
	userSelectedPath?: string,
	activeFilePath?: string
): { targetRoot: string; candidates: ProjectFolderCandidate[] } {
	const candidates = discoverProjectCandidates(workspaceRoot);

	// 1. 如果用户手动指定过，且路径仍然有效，优先采用
	if (userSelectedPath && fs.existsSync(userSelectedPath)) {
		const resolvedUser = path.resolve(userSelectedPath);
		// 确保在候选列表中
		if (!candidates.some((c) => path.resolve(c.fsPath) === resolvedUser)) {
			const assessment = scoreProjectDir(resolvedUser);
			candidates.push({
				fsPath: resolvedUser,
				name: path.basename(resolvedUser),
				score: assessment.score,
				isWorkspaceRoot: resolvedUser === path.resolve(workspaceRoot),
				hasDotGithub: assessment.hasDotGithub,
				hasInstructions: assessment.hasInstructions,
				detectedStacks: assessment.stacks,
			});
		}
		return { targetRoot: resolvedUser, candidates };
	}

	// 2. 如果存在活动编辑器文件，尝试溯源推导
	if (activeFilePath) {
		const inferred = findProjectRootFromActiveFile(activeFilePath, workspaceRoot);
		if (inferred && fs.existsSync(inferred)) {
			return { targetRoot: path.resolve(inferred), candidates };
		}
	}

	// 3. 按照评分最高者作为推荐
	if (candidates.length > 0) {
		return { targetRoot: path.resolve(candidates[0].fsPath), candidates };
	}

	// 4. 兜底回退工作区根目录
	return { targetRoot: path.resolve(workspaceRoot), candidates };
}

/**
 * 扫描指定项目工程目录的 AI 资产现状
 */
export function scanWorkspaceGuard(
	workspaceRoot: string,
	workspaceName: string,
	selectedProjectRoot?: string,
	activeFilePath?: string
): WorkspaceGuardStatus {
	const { targetRoot, candidates } = resolveTargetProjectRoot(workspaceRoot, selectedProjectRoot, activeFilePath);
	const targetProjectName = path.basename(targetRoot) || workspaceName;

	const detectedStacks = detectStacksInDir(targetRoot);
	const dotGithubPath = path.join(targetRoot, ".github");
	const dotGithubExists = fs.existsSync(dotGithubPath) && fs.statSync(dotGithubPath).isDirectory();

	const instructionsPath = path.join(dotGithubPath, "copilot-instructions.md");
	let hasInstructions = false;
	let instructionsStats: InstructionsStats | undefined;

	if (fs.existsSync(instructionsPath) && fs.statSync(instructionsPath).isFile()) {
		hasInstructions = true;
		try {
			const content = fs.readFileSync(instructionsPath, "utf-8");
			instructionsStats = {
				lineCount: content.split(/\r?\n/).length,
				charCount: content.length,
			};
		} catch (err) {
			console.error("[WorkspaceGuard] read instructions error:", err);
		}
	}

	const instructionFiles = listFilesMatching(
		path.join(dotGithubPath, "instructions"),
		(name) => name.endsWith(".instructions.md") || name.endsWith(".md")
	);

	const skills = listSubdirectories(path.join(dotGithubPath, "skills")).filter((subDir) => {
		const skillMd = path.join(dotGithubPath, "skills", subDir, "SKILL.md");
		return fs.existsSync(skillMd) && fs.statSync(skillMd).isFile();
	});

	const prompts = listFilesMatching(
		path.join(dotGithubPath, "prompts"),
		(name) => name.endsWith(".prompt.md") || name.endsWith(".md")
	);

	const agents = listFilesMatching(
		path.join(dotGithubPath, "agents"),
		(name) => name.endsWith(".agent.md") || name.endsWith(".md")
	);

	let defenseLevel: "none" | "basic" | "deep" = "none";
	if (hasInstructions || instructionFiles.length > 0) {
		if (hasInstructions && (instructionFiles.length > 0 || skills.length > 0)) {
			defenseLevel = "deep";
		} else {
			defenseLevel = "basic";
		}
	}

	return {
		hasWorkspace: true,
		workspaceRoot,
		workspaceName,
		selectedProjectRoot: targetRoot,
		selectedProjectName: targetProjectName,
		projectCandidates: candidates,
		detectedStacks,
		dotGithubExists,
		hasInstructions,
		instructionsPath: hasInstructions ? instructionsPath : path.join(dotGithubPath, "copilot-instructions.md"),
		instructionsStats,
		instructionFiles,
		skills,
		prompts,
		agents,
		defenseLevel,
	};
}

/**
 * 辅助：列出指定目录下匹配条件的文件名
 */
function listFilesMatching(dirPath: string, predicate: (name: string) => boolean): string[] {
	if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
		return [];
	}
	try {
		return fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((dirent) => dirent.isFile() && predicate(dirent.name))
			.map((dirent) => dirent.name);
	} catch {
		return [];
	}
}

/**
 * 辅助：列出指定目录下的所有子目录名
 */
function listSubdirectories(dirPath: string): string[] {
	if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
		return [];
	}
	try {
		return fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((dirent) => dirent.isDirectory())
			.map((dirent) => dirent.name);
	} catch {
		return [];
	}
}

/**
 * 生成项目总纲模板内容
 */
export function buildWorkspaceInstructionsTemplate(workspaceName: string): string {
	return `# ${workspaceName} 仓库指令总纲

本文件定义本仓库的最高执行准则、红线约束与领域技能路由。

---

## 1. 🚨 仓库红线（违反必死，严格执行）

1. **讨论与行动边界**：无明确变更诉求（如改/修/实现）时保持只读讨论，严禁修改文件；收到明确诉求后，先报备验证标准即可直接执行闭环，无需多轮请示。
2. **变更授权清单**：以下高危动作必须取得开发者明确授权——重写 Git 历史、force push、推远端、删除已有文件或分支、改动对外版本号、生产环境变更、清理业务数据。
3. **改动范围收敛**：只做被要求的和明确必要的改动。发现的其他问题只报告，严禁“顺手优化”或重构无关代码。
4. **验证真实性铁律**：“写了代码” $\\neq$ “测过”。编译或类型检查只证明代码可构建，不得充当行为验证。所有修改必须运行能直接证伪的测试或执行命令，并严格核对退出码（Exit Code = 0）、失败数与断言输出。
5. **两次停手止损**：同一问题连续两次修复无效即停止试错，输出「已排除的假设 / 最可疑方向 / 一个能区分剩余假设的最小实验」，交由开发者决策。
6. **机密与凭证安全**：API 密钥、密码、私钥、Token 严禁写入代码、文档或提示词中，避免敏感信息泄露。

---

## 2. 🧭 领域规约与技能路由

- **模块化规约 (\`.github/instructions/\`)**：针对特定文件类型与代码路径的精准语言规约（必须带 \`applyTo\` 属性匹配）。
- **场景化操作技能 (\`.github/skills/\`)**：复杂多步研发流程标准 SOP（含前置依赖检查、执行步骤与强制验证闭环）。
- **提示词模板 (\`.github/prompts/\`)**：高频重复研发动作（如单元测试生成、Code Review、发布打包）的标准化入口。

---

## 3. 🛠️ 研发与代码规范

- **代码注释**：注释语言遵循相邻代码惯例；默认精简，只写代码表达不出的设计原因或不变量，不为自解释代码补注释。
- **提交信息**：Git Commit 遵循 Conventional Commits 规范（\`feat:\`, \`fix:\`, \`refactor:\`, \`docs:\`, \`test:\` 等），保持原子性提交。
`;
}

/**
 * 获取技术栈指令模板内容
 */
export function buildStackInstructionsTemplate(stackId: SupportedStack): { fileName: string; content: string } {
	switch (stackId) {
		case "typescript":
			return {
				fileName: "typescript.instructions.md",
				content: `---
applyTo: "**/*.{ts,tsx,js,jsx}"
---

# TypeScript / JavaScript 工程规约

本规约在编辑所有 TypeScript / JavaScript 文件时自动注入并生效。

---

## 1. 类型安全守卫
- **严禁滥用 \`any\`**：无法提前确定类型时优先使用 \`unknown\`，并配合类型守卫（Type Guard）或模式断言进行收窄。
- **契约显式定义**：所有对外导出的公共函数、类方法必须显式标注参数类型与返回类型，禁止依赖隐式推导。
- **接口与类型别名**：面向对象与数据契约优先使用 \`interface\`，联合类型、交叉类型或元组操作使用 \`type\`。

## 2. 异步与异常治理
- **异常捕获边界**：严禁写空的 \`catch {}\` 吞掉异常；捕获到异常时必须记录有价值的上下文或向上封装抛出。
- **Async / Await 优先**：统一使用 \`async / await\` 代替长链式 Promise；并发无依赖的任务使用 \`Promise.all\`。

## 3. 不可变性与资源管理
- **不可变数据倾向**：局部变量一律优先使用 \`const\`；函数入参尽量避免就地突变（Mutate）。
- **事件与资源释放**：涉及事件监听器、定时器或订阅操作时，必须成对提供相应的 Dispose 或取消逻辑，杜绝内存泄漏。
`,
			};

		case "csharp":
			return {
				fileName: "csharp.instructions.md",
				content: `---
applyTo: "**/*.{cs,csproj}"
---

# C# / .NET 工程规约

本规约在编辑所有 C# 源码及工程文件时自动注入并生效。

---

## 1. 现代语言特性与空安全
- **可空引用类型 (Nullable Reference Types)**：严格遵循 NRT 规范，对可能为 null 的参数与返回值显式声明 \`?\`，杜绝潜在的 \`NullReferenceException\`。
- **不可变数据优先**：值对象、DTO 和只读模型优先使用 \`record\` 或 \`record struct\`；只读集合对外暴露使用 \`IReadOnlyList<T>\` 或 \`IReadOnlyDictionary<TKey, TValue>\`。

## 2. 异步编程与资源释放
- **异步全链路穿透**：所有异步方法命名以 \`Async\` 结尾；严禁在异步代码中调用 \`.Result\` 或 \`.Wait()\` 造成线程阻塞与死锁。
- **取消令牌支持**：耗时或 I/O 操作必须向下传递 \`CancellationToken\`，支持优雅取消。
- **资源确定性释放**：实现 \`IDisposable\` 或 \`IAsyncDisposable\` 的对象必须使用 \`using var\` 或 \`await using var\` 确保及时释放。

## 3. 性能与内存纪律
- **减少装箱与分配**：高频解析与切片场景优先考虑 \`ReadOnlySpan<char>\` 与 \`Memory<T>\`，避免无谓的临时字符串分配。
`,
			};

		case "python":
			return {
				fileName: "python.instructions.md",
				content: `---
applyTo: "**/*.py"
---

# Python 工程规约

本规约在编辑所有 Python 源码时自动注入并生效。

---

## 1. 类型提示与接口契约
- **强制类型提示**：所有公共函数、模块接口必须提供完整的 Type Hints（参数与返回值类型），采用 Python 3.10+ 标准联合类型语法（如 \`str | None\`）。
- **自解释命名**：遵循 PEP 8 命名规范（函数与变量使用 snake_case，类名使用 PascalCase，常量使用 UPPER_SNAKE_CASE）。

## 2. 资源管理与异常防御
- **上下文管理器优先**：文件操作、数据库连接、锁获取必须使用 \`with\` 上下文管理器，确保异常分支下资源可靠回收。
- **精准捕获异常**：禁止裸 \`except:\`，必须捕获特定的 Exception 子类；捕获后若需再抛出，使用 \`raise ... from err\` 保留原始调用栈。

## 3. 代码质量与可维护性
- **禁止可变默认参数**：严禁在函数签名中使用 \`def func(items=[])\`，使用 \`None\` 作为哨兵值并在函数体内初始化。
- **推导式简洁度**：列表/字典推导式仅用于简单的数据映射与过滤，严禁编写嵌套超过 2 层的复杂推导式。
`,
			};

		case "cpp":
			return {
				fileName: "cpp.instructions.md",
				content: `---
applyTo: "**/*.{c,cpp,cc,cxx,h,hpp,hxx}"
---

# C / C++ 工程规约

本规约在编辑所有 C / C++ 源码及头文件时自动注入并生效。

---

## 1. 内存与资源安全 (RAII 铁律)
- **绝对 RAII 纪律**：严禁裸指针 \`new\` / \`delete\` 或 \`malloc\` / \`free\`；动态所有权统一使用 \`std::unique_ptr\`，共享所有权使用 \`std::shared_ptr\`。
- **视图类型优先传递**：对于只读连续内存或只读字符串传递，优先采用 \`std::string_view\` 与 \`std::span\`，消除无谓拷贝。

## 2. 现代 C++ 规范与类型安全
- **Const 正确性 (Const-Correctness)**：所有不修改成员状态的方法一律标为 \`const\`；局部不可变变量统一标为 \`const\` 或 \`constexpr\`。
- **严禁 C 风格强转**：类型转换必须显式使用 \`static_cast\`、\`reinterpret_cast\` 或 \`dynamic_cast\`，杜绝隐式切片与未定义行为。
- **显式所有权转移**：耗时对象传递采用移动语义 (\`std::move\`)，移动后的对象不得再次访问。

## 3. 头文件与编译解耦
- **头文件卫士**：统一使用 \`#pragma once\`。
- **前置声明与最小包含**：头文件中能使用前置声明（Forward Declaration）的，严禁包含完整头文件，缩短构建时长。
`,
			};

		case "java":
			return {
				fileName: "java.instructions.md",
				content: `---
applyTo: "**/*.java"
---

# Java 工程规约

本规约在编辑所有 Java 源码时自动注入并生效。

---

## 1. 空安全与集合防御
- **防御性空处理**：公共方法对可能为空的入参必须做显式校验（如 \`Objects.requireNonNull\`）；返回值为空时优先返回 \`Optional<T>\` 或空集合，禁止返回裸 \`null\`。
- **只读集合防御**：对外暴露的集合尽量使用 \`Collections.unmodifiableList\` 或 \`List.copyOf\` 提供只读视图，杜绝外部就地篡改。

## 2. 资源管理与并发纪律
- **Try-With-Resources 优先**：凡是实现 \`AutoCloseable\` 的 I/O 流、连接或通道，必须使用 \`try (...) {}\` 语句块包裹，保证资源确定性释放。
- **线程池与虚拟线程纪律**：严禁在业务代码中显式裸起 \`new Thread()\`；异步任务统一使用托管线程池或虚拟线程（Virtual Thread），并妥善处理 \`InterruptedException\`。

## 3. 面向对象与代码质量
- **覆盖必须标注解**：重写父类或接口方法必须加 \`@Override\` 注解。
- **不可变数据倾向**：纯数据载体、DTO 优先使用 Java 17+ 的 \`record\`，不可变字段显式加 \`final\`。
`,
			};
	}
}

/**
 * 生成自定义场景技能模板
 */
export function buildWorkspaceSkillTemplate(skillName: string): string {
	const sanitizedName = skillName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	return `---
name: ${sanitizedName}
description: 简述该技能适用的业务场景与前置时机。例如：当开发者需要进行 ${sanitizedName} 操作时调用。
---

# ${skillName} 场景化操作技能

本技能定义了 ${skillName} 的标准化操作流程与强制验证闭环。

---

## 1. 🚨 前置条件与检查
- 执行前必须核实相关环境、网络、依赖项及工作区就绪状态。
- 若存在未提交的冲突代码或脏工作区，必须先排查解决再启动。

## 2. 🛠️ 标准操作流程 (SOP)

### 步骤一：环境与参数准备
1. 确认目标环境与配置参数。
2. 打印当前状态日志，便于问题追溯。

### 步骤二：执行核心变更
1. 运行目标任务或命令脚本。
2. 保持操作的原子性，记录关键输出信息。

---

## 3. ✅ 强制验证与退出码核对闭环（铁律）
- **绝不相信“命令执行完毕”**：命令执行完成不等于业务逻辑成功，必须核对返回的退出码（Exit Code 必须为 0）。
- **核验关键业务指标**：检查生成的产物完整性、服务响应状态或单测通过率。
- **止损方案**：若验证失败，立即输出明确的错误根因与最小回滚步骤，严禁静默忽略。
`;
}
