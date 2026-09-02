import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
	detectStacksInDir,
	discoverProjectCandidates,
	findProjectRootFromActiveFile,
	resolveTargetProjectRoot,
	scanWorkspaceGuard,
	buildWorkspaceInstructionsTemplate,
	buildStackInstructionsTemplate,
	buildWorkspaceSkillTemplate,
	SUPPORTED_STACKS,
} from "../workspaceGuard";
import { resolveFileDecoration } from "../workspaceGuardDecoration";

suite("Workspace Guard & Engineering Defense", () => {
	let testTmpDir: string;

	setup(() => {
		testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-guard-test-"));
	});

	teardown(() => {
		try {
			if (fs.existsSync(testTmpDir)) {
				fs.rmSync(testTmpDir, { recursive: true, force: true });
			}
		} catch {
			// ignore cleanup error in tmp
		}
	});

	test("detectStacksInDir: 能够准确嗅探工作区特征文件与技术栈（TS、C#、Python、C/C++、Java）", () => {
		// 1. 空目录
		assert.deepStrictEqual(detectStacksInDir(testTmpDir), []);

		// 2. TypeScript / JS 识别
		fs.writeFileSync(path.join(testTmpDir, "package.json"), "{}");
		assert.deepStrictEqual(detectStacksInDir(testTmpDir), ["typescript"]);

		// 3. 混合 C#、Python 与 C/C++
		fs.writeFileSync(path.join(testTmpDir, "App.csproj"), "<Project />");
		fs.writeFileSync(path.join(testTmpDir, "requirements.txt"), "pytest");
		fs.writeFileSync(path.join(testTmpDir, "CMakeLists.txt"), "cmake_minimum_required()");
		const mixed = detectStacksInDir(testTmpDir);
		assert.ok(mixed.includes("typescript"));
		assert.ok(mixed.includes("csharp"));
		assert.ok(mixed.includes("python"));
		assert.ok(mixed.includes("cpp"));

		// 4. Java 识别
		fs.writeFileSync(path.join(testTmpDir, "pom.xml"), "<project />");
		const javaStacks = detectStacksInDir(testTmpDir);
		assert.ok(javaStacks.includes("java"));
	});

	test("discoverProjectCandidates & resolveTargetProjectRoot: 智能识别 Monorepo/子工程及活动文件推导", () => {
		// 模拟多目录复合工作区结构：
		// testTmpDir (外层大根目录)
		//   ├── core-backend (子工程，C# + .github/copilot-instructions.md)
		//   └── web-frontend (子工程，package.json)
		const backendDir = path.join(testTmpDir, "core-backend");
		const frontendDir = path.join(testTmpDir, "web-frontend");
		fs.mkdirSync(backendDir, { recursive: true });
		fs.mkdirSync(frontendDir, { recursive: true });

		fs.writeFileSync(path.join(backendDir, "Backend.csproj"), "<Project />");
		const dotGithub = path.join(backendDir, ".github");
		fs.mkdirSync(dotGithub, { recursive: true });
		fs.writeFileSync(path.join(dotGithub, "copilot-instructions.md"), "# Backend Instructions");

		fs.writeFileSync(path.join(frontendDir, "package.json"), "{}");

		// 1. 候选发现：优先推荐得分更高的核心子工程（core-backend）
		const candidates = discoverProjectCandidates(testTmpDir);
		assert.ok(candidates.length >= 2);
		assert.strictEqual(candidates[0].name, "core-backend");
		assert.strictEqual(candidates[0].hasInstructions, true);

		// 2. 活动文件反溯推导：打开 web-frontend/src/index.ts 时推导到 web-frontend
		const fakeActiveFile = path.join(frontendDir, "src", "index.ts");
		const inferred = findProjectRootFromActiveFile(fakeActiveFile, testTmpDir);
		assert.strictEqual(path.resolve(inferred!), path.resolve(frontendDir));

		// 3. 综合决议：传活动文件时优先解析为对应子目录
		const resolved = resolveTargetProjectRoot(testTmpDir, undefined, fakeActiveFile);
		assert.strictEqual(path.resolve(resolved.targetRoot), path.resolve(frontendDir));

		// 4. 用户手动选择优先于自动推导
		const manualResolved = resolveTargetProjectRoot(testTmpDir, backendDir, fakeActiveFile);
		assert.strictEqual(path.resolve(manualResolved.targetRoot), path.resolve(backendDir));
	});

	test("readWorkspaceSettingsIntent: 结合 .vscode/settings.json 负向排除只读库并正向强化目标工程", () => {
		// 模拟用户的工作区配置
		// 外层目录包含：
		// - libiao-copilot (目标开发项目)
		// - vscode-docs (参考库，设置了 git.ignoredRepositories)
		// - vscode-src (参考库，设置了 git.ignoredRepositories)
		const libiaoDir = path.join(testTmpDir, "libiao-copilot");
		const docsDir = path.join(testTmpDir, "vscode-docs");
		const srcDir = path.join(testTmpDir, "vscode-src");

		fs.mkdirSync(libiaoDir, { recursive: true });
		fs.mkdirSync(docsDir, { recursive: true });
		fs.mkdirSync(srcDir, { recursive: true });

		fs.writeFileSync(path.join(libiaoDir, "package.json"), "{}");
		fs.writeFileSync(path.join(docsDir, "package.json"), "{}");
		fs.writeFileSync(path.join(srcDir, "package.json"), "{}");

		const dotVscode = path.join(testTmpDir, ".vscode");
		fs.mkdirSync(dotVscode, { recursive: true });
		const settingsContent = JSON.stringify({
			"git.ignoredRepositories": ["vscode-docs", "vscode-src"],
			"chat.promptFilesLocations": {
				"libiao-copilot/.github/prompts": true,
			},
		});
		fs.writeFileSync(path.join(dotVscode, "settings.json"), settingsContent);

		const candidates = discoverProjectCandidates(testTmpDir);

		// 1. 验证负向排除：vscode-docs 与 vscode-src 应该被直接过滤，不在候选清单中
		const candidateNames = candidates.map((c) => c.name);
		assert.ok(!candidateNames.includes("vscode-docs"), "被忽略的仓库 vscode-docs 不应出现在工程候选中");
		assert.ok(!candidateNames.includes("vscode-src"), "被忽略的仓库 vscode-src 不应出现在工程候选中");

		// 2. 验证正向加权：libiao-copilot 应该成为第一顺位推荐候选
		assert.ok(candidateNames.includes("libiao-copilot"));
		assert.strictEqual(candidates[0].name, "libiao-copilot");
		assert.ok(candidates[0].score >= 50, "命中 promptFilesLocations 的子工程应获得高置信度加分");
	});

	test("scanWorkspaceGuard: 正确识别未布防、基础布防与深度布防等级", () => {
		// 初始空目录 -> none
		let status = scanWorkspaceGuard(testTmpDir, "test-workspace");
		assert.strictEqual(status.hasWorkspace, true);
		assert.strictEqual(status.hasInstructions, false);
		assert.strictEqual(status.defenseLevel, "none");
		assert.strictEqual(status.instructionFiles.length, 0);
		assert.strictEqual(status.skills.length, 0);

		// 创建 .github/copilot-instructions.md -> basic
		const dotGithub = path.join(testTmpDir, ".github");
		fs.mkdirSync(dotGithub, { recursive: true });
		fs.writeFileSync(path.join(dotGithub, "copilot-instructions.md"), "# Test Instructions\nLine 2\nLine 3");

		status = scanWorkspaceGuard(testTmpDir, "test-workspace");
		assert.strictEqual(status.hasInstructions, true);
		assert.strictEqual(status.defenseLevel, "basic");
		assert.strictEqual(status.instructionsStats?.lineCount, 3);

		// 添加模块化规约与场景技能 -> deep
		const instructionsDir = path.join(dotGithub, "instructions");
		fs.mkdirSync(instructionsDir, { recursive: true });
		fs.writeFileSync(path.join(instructionsDir, "ts.instructions.md"), "---\napplyTo: '**/*.ts'\n---");

		const skillsDir = path.join(dotGithub, "skills", "deploy-check");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "---\nname: deploy-check\n---");

		status = scanWorkspaceGuard(testTmpDir, "test-workspace");
		assert.strictEqual(status.defenseLevel, "deep");
		assert.strictEqual(status.instructionFiles.length, 1);
		assert.strictEqual(status.skills.length, 1);
		assert.strictEqual(status.skills[0], "deploy-check");
	});

	test("buildWorkspaceInstructionsTemplate: 生成规范且包含关键红线的项目总纲", () => {
		const template = buildWorkspaceInstructionsTemplate("LibiaoRobotics");
		assert.ok(template.includes("# LibiaoRobotics 仓库指令总纲"));
		assert.ok(template.includes("🚨 仓库红线"));
		assert.ok(template.includes("讨论与行动边界"));
		assert.ok(template.includes("验证真实性铁律"));
		assert.ok(template.includes("退出码（Exit Code = 0）"));
		assert.ok(template.includes("两次停手止损"));
		assert.ok(template.includes(".github/instructions/"));
		assert.ok(template.includes(".github/skills/"));
	});

	test("buildStackInstructionsTemplate: 针对各主流语言生成精确 applyTo 的技术栈规约", () => {
		assert.strictEqual(SUPPORTED_STACKS.length, 5);

		// TypeScript
		const ts = buildStackInstructionsTemplate("typescript");
		assert.strictEqual(ts.fileName, "typescript.instructions.md");
		assert.ok(ts.content.includes("applyTo: \"**/*.{ts,tsx,js,jsx}\""));
		assert.ok(ts.content.includes("严禁滥用 `any`"));

		// C#
		const cs = buildStackInstructionsTemplate("csharp");
		assert.strictEqual(cs.fileName, "csharp.instructions.md");
		assert.ok(cs.content.includes("applyTo: \"**/*.{cs,csproj}\""));
		assert.ok(cs.content.includes("可空引用类型 (Nullable Reference Types)"));

		// Python
		const py = buildStackInstructionsTemplate("python");
		assert.strictEqual(py.fileName, "python.instructions.md");
		assert.ok(py.content.includes("applyTo: \"**/*.py\""));
		assert.ok(py.content.includes("强制类型提示"));

		// C / C++
		const cpp = buildStackInstructionsTemplate("cpp");
		assert.strictEqual(cpp.fileName, "cpp.instructions.md");
		assert.ok(cpp.content.includes("applyTo: \"**/*.{c,cpp,cc,cxx,h,hpp,hxx}\""));
		assert.ok(cpp.content.includes("绝对 RAII 纪律"));
		assert.ok(cpp.content.includes("std::unique_ptr"));

		// Java
		const java = buildStackInstructionsTemplate("java");
		assert.strictEqual(java.fileName, "java.instructions.md");
		assert.ok(java.content.includes("applyTo: \"**/*.java\""));
		assert.ok(java.content.includes("Try-With-Resources 优先"));
		assert.ok(java.content.includes("AutoCloseable"));
	});

	test("buildWorkspaceSkillTemplate: 生成三段式 SOP 结构与退出码验证铁律", () => {
		const skill = buildWorkspaceSkillTemplate("Database-Migration");
		assert.ok(skill.includes("name: database-migration"));
		assert.ok(skill.includes("1. 🚨 前置条件与检查"));
		assert.ok(skill.includes("2. 🛠️ 标准操作流程 (SOP)"));
		assert.ok(skill.includes("3. ✅ 强制验证与退出码核对闭环（铁律）"));
		assert.ok(skill.includes("退出码（Exit Code 必须为 0）"));
	});

	test("resolveFileDecoration: 资源管理器中对目标工程、只读库、.github 及关键资产的修饰规则决议", () => {
		const wsRoot = path.join(testTmpDir, "workspace");
		const targetProject = path.join(wsRoot, "libiao-copilot");
		const readOnlyRepo = path.join(wsRoot, "vscode-src");
		const ignored = new Set(["vscode-src"]);

		// 1. 目标工程自身 -> 🏰 徽章与绿色
		const targetDec = resolveFileDecoration(targetProject, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(targetDec);
		assert.strictEqual(targetDec.badge, "🏰");
		assert.ok(targetDec.tooltip?.includes("核心开发工程"));

		// 2. 只读参考库 -> 📖 徽章
		const roDec = resolveFileDecoration(readOnlyRepo, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(roDec);
		assert.strictEqual(roDec.badge, "📖");
		assert.ok(roDec.tooltip?.includes("只读参考工程"));

		// 3. .github 目录 -> AI 徽章
		const dotGithubPath = path.join(targetProject, ".github");
		const ghDec = resolveFileDecoration(dotGithubPath, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(ghDec);
		assert.strictEqual(ghDec.badge, "AI");
		assert.ok(ghDec.tooltip?.includes("AI 工程防线"));

		// 4. copilot-instructions.md -> 纲 徽章
		const instructionsFile = path.join(targetProject, ".github", "copilot-instructions.md");
		const instDec = resolveFileDecoration(instructionsFile, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(instDec);
		assert.strictEqual(instDec.badge, "纲");
		assert.ok(instDec.tooltip?.includes("项目指令总纲"));

		// 5. instructions/ts.instructions.md -> 规 徽章
		const tsInstFile = path.join(targetProject, ".github", "instructions", "ts.instructions.md");
		const ruleDec = resolveFileDecoration(tsInstFile, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(ruleDec);
		assert.strictEqual(ruleDec.badge, "规");
		assert.ok(ruleDec.tooltip?.includes("模块化规约"));

		// 6. skills/db-migration/SKILL.md -> SOP 徽章
		const skillFile = path.join(targetProject, ".github", "skills", "db-migration", "SKILL.md");
		const skillDec = resolveFileDecoration(skillFile, {
			workspaceRoot: wsRoot,
			selectedProjectRoot: targetProject,
			ignoredRepositories: ignored,
		});
		assert.ok(skillDec);
		assert.strictEqual(skillDec.badge, "SOP");
		assert.ok(skillDec.tooltip?.includes("技能 SOP"));
	});
});
