import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
	extractUserNameFromMemory,
	renderUserMemoryTemplate,
	updateUserNameInMemory,
	isMemoryContentEqual,
	isUserMemoryTemplateInjected,
	formatBackupTimestamp,
	backupMemoryToDesktop,
	buildUserMemoryEvaluationPrompt,
	buildCustomMemoryEvaluationPrompt,
	buildCombinedMemoryEvaluationPrompt,
	findOrgInstructionsFilePath,
	isFileWritable,
	clearAndLockFile,
	buildOrgInstructionsEvaluationPrompt,
} from "../views/configView";

import {
	formatBuildDate,
	VersionManager,
} from "../versionManager";

suite("User Memory & Best Practices", () => {
	test("formatBuildDate & VersionManager: 正确格式化日期与获取版本信息", () => {
		const fixedDate = new Date(2026, 7, 25); // 2026-08-25
		assert.strictEqual(formatBuildDate(fixedDate), "2026-08-25");

		const pkgPath = path.join(__dirname, "..", "..", "package.json");
		const expectedVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
		const version = VersionManager.getVersion();
		assert.ok(version.length > 0, "版本号不应为空");
		assert.strictEqual(version, expectedVersion, "VersionManager 应与 package.json 中的版本号严格保持一致");

		const buildDate = VersionManager.getBuildDate();
		assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(buildDate), `打包日期应符合 YYYY-MM-DD 格式，当前为: ${buildDate}`);
	});

	test("正确从记忆文件内容中提取用户称呼/昵称（含无称呼场景）", () => {
		const cases = [
			{ text: "- 称呼用户为“特哥”。\n- 默认使用中文", expected: "特哥" },
			{ text: '- 称呼用户为"碳基领导"。\n', expected: "碳基领导" },
			{ text: "- 称呼用户为“硅基驯兽师”", expected: "硅基驯兽师" },
			{ text: "- 称呼用户为 代码天尊。", expected: "代码天尊" },
			{ text: "* 称呼用户为“尊贵的碳基生物”。", expected: "尊贵的碳基生物" },
			{ text: "- 称呼用户为“Ctrl+C 首席架构师”。", expected: "Ctrl+C 首席架构师" },
			{ text: "# 用户核心记忆\n\n## 沟通\n- 默认使用中文交流", expected: "" },
			{ text: "这是一份普通的 markdown 内容，没有称呼设置", expected: "" },
			{ text: "", expected: "" },
		];

		for (const c of cases) {
			const extracted = extractUserNameFromMemory(c.text);
			assert.strictEqual(extracted, c.expected, `输入: ${c.text}`);
		}
	});

	test("updateUserNameInMemory: 仅修改称呼且不改动其他正文", () => {
		const originalDoc = `# 用户核心记忆\n\n## 沟通\n\n- 称呼用户为“特哥”。\n- 默认使用中文交流；\n- 默认长度：简单问题 1-3 句。\n\n## 工程默认\n- 必须只做被要求的改动。`;

		// 1. 修改已有称呼
		const updated = updateUserNameInMemory(originalDoc, "碳基领导");
		assert.ok(updated.includes("- 称呼用户为“碳基领导”。\n"));
		assert.ok(!updated.includes("特哥"));
		assert.ok(updated.includes("默认使用中文交流；"));
		assert.ok(updated.includes("## 工程默认\n- 必须只做被要求的改动。"));

		// 2. 清空称呼时仅移除称呼行，保留其余内容
		const cleared = updateUserNameInMemory(originalDoc, "");
		assert.ok(!cleared.includes("称呼用户为"));
		assert.ok(cleared.includes("## 沟通\n\n- 默认使用中文交流；"));
		assert.ok(cleared.includes("## 工程默认"));

		// 3. 原文无称呼时插入到 ## 沟通 下方
		const noNameDoc = `# 用户核心记忆\n\n## 沟通\n\n- 默认使用中文交流；`;
		const inserted = updateUserNameInMemory(noNameDoc, "代码天尊");
		assert.ok(inserted.includes("## 沟通\n\n- 称呼用户为“代码天尊”。\n- 默认使用中文交流；"));
	});

	test("isMemoryContentEqual: 准确识别内容一致性并忽略不同换行符差异", () => {
		const contentA = "# 标题\r\n\r\n- 条目 1\r\n- 条目 2\r\n";
		const contentB = "# 标题\n\n- 条目 1\n- 条目 2\n";
		const contentC = "# 标题\n\n- 条目 1\n- 条目 2 (不同内容)\n";

		assert.strictEqual(isMemoryContentEqual(contentA, contentB), true, "CRLF与LF应被视作一致");
		assert.strictEqual(isMemoryContentEqual(contentA, contentC), false, "内容不同应判定为不一致");
	});

	test("formatBackupTimestamp: 生成 YYYYMMDD_HHmmss 格式时间戳", () => {
		const fixedDate = new Date(2026, 7, 25, 14, 30, 45); // 月份 7 是 8 月
		const ts = formatBackupTimestamp(fixedDate);
		assert.strictEqual(ts, "20260825_143045");
	});

	test("backupMemoryToDesktop: 正确备份原记忆内容到目标目录", () => {
		const tempDir = path.join(os.tmpdir(), "libiao-test-backup-" + Date.now());
		fs.mkdirSync(tempDir, { recursive: true });
		try {
			const originalContent = "# 旧的核心记忆文件内容\n- 历史记录重要准则";
			const fixedDate = new Date(2026, 7, 25, 10, 20, 30);
			const backupPath = backupMemoryToDesktop(originalContent, tempDir, fixedDate);

			assert.ok(backupPath, "应成功返回备份文件路径");
			assert.strictEqual(path.basename(backupPath), "user-preferences.backup.20260825_102030.md");
			assert.ok(fs.existsSync(backupPath), "备份文件应存在于目标目录");
			const saved = fs.readFileSync(backupPath, "utf-8");
			assert.strictEqual(saved, originalContent);

			// 空内容应返回 null 且不创建
			const emptyBackup = backupMemoryToDesktop("", tempDir);
			assert.strictEqual(emptyBackup, null);

			// 自定义前缀备份测试
			const customBackupPath = backupMemoryToDesktop(
				originalContent,
				tempDir,
				fixedDate,
				"custom-notes"
			);
			assert.ok(customBackupPath);
			assert.strictEqual(path.basename(customBackupPath), "custom-notes.backup.20260825_102030.md");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("内置模板存在且包含 {{USER_NAME}} 占位符", () => {
		const templatePath = path.resolve(__dirname, "../../assets/templates/user-preferences.template.md");
		assert.ok(fs.existsSync(templatePath), "模板文件必须存在于 assets/templates 目录");
		const content = fs.readFileSync(templatePath, "utf-8");
		assert.ok(content.includes("{{USER_NAME}}"), "模板必须包含 {{USER_NAME}} 占位符");

		// 有称呼时替换
		const replaced = renderUserMemoryTemplate(content, "硅基驯兽师");
		assert.ok(replaced.includes("称呼用户为“硅基驯兽师”。"));
		assert.ok(!replaced.includes("{{USER_NAME}}"));

		// 无称呼时自动剥离称呼整行
		const replacedEmpty = renderUserMemoryTemplate(content, "");
		assert.ok(!replacedEmpty.includes("称呼用户为"));
		assert.ok(!replacedEmpty.includes("{{USER_NAME}}"));
		assert.ok(replacedEmpty.includes("默认使用中文交流"));
	});

	test("isUserMemoryTemplateInjected: 正确识别核心记忆模板注入状态（无论带称呼与否）", () => {
		const template = "# 用户核心记忆\n\n## 沟通\n- 称呼用户为“{{USER_NAME}}”。\n- 默认使用中文交流；\n\n## 工程默认\n- 必须只做被要求的改动。";

		// 1. 注入并设置了称呼
		const injectedWithName = "# 用户核心记忆\n\n## 沟通\n- 称呼用户为“特哥”。\n- 默认使用中文交流；\n\n## 工程默认\n- 必须只做被要求的改动。";
		assert.strictEqual(isUserMemoryTemplateInjected(injectedWithName, template), true, "设置了称呼且其余内容一致应判定已注入");

		// 2. 注入且无称呼
		const injectedNoName = "# 用户核心记忆\n\n## 沟通\n- 默认使用中文交流；\n\n## 工程默认\n- 必须只做被要求的改动。";
		assert.strictEqual(isUserMemoryTemplateInjected(injectedNoName, template), true, "无称呼且其余内容一致应判定已注入");

		// 3. 用户修改了规则正文（多加了一条规则或删减了内容）
		const userModified = "# 用户核心记忆\n\n## 沟通\n- 称呼用户为“特哥”。\n- 默认使用中文交流；\n\n## 工程默认\n- 必须只做被要求的改动。\n- 自定义额外规则";
		assert.strictEqual(isUserMemoryTemplateInjected(userModified, template), false, "内容被用户修改应判定未注入");

		// 4. 空内容或无文件
		assert.strictEqual(isUserMemoryTemplateInjected("", template), false, "空内容应判定未注入");
		assert.strictEqual(isUserMemoryTemplateInjected("   \n\t ", template), false, "纯空白字符应判定未注入");
	});

	test("正确推导跨平台 globalStorage 目录下的 memory 路径", () => {
		const mockGlobalStoragePath = path.join("C:", "Users", "test", "AppData", "Roaming", "Code", "User", "globalStorage", "libiao.libiao-copilot");
		const globalStorageRoot = path.dirname(mockGlobalStoragePath);
		const memoryFilePath = path.join(globalStorageRoot, "github.copilot-chat", "memory-tool", "memories", "user-preferences.md");
		const memoryDirPath = path.join(globalStorageRoot, "github.copilot-chat", "memory-tool", "memories");

		assert.strictEqual(
			memoryFilePath,
			path.join("C:", "Users", "test", "AppData", "Roaming", "Code", "User", "globalStorage", "github.copilot-chat", "memory-tool", "memories", "user-preferences.md")
		);
		assert.strictEqual(
			memoryDirPath,
			path.join("C:", "Users", "test", "AppData", "Roaming", "Code", "User", "globalStorage", "github.copilot-chat", "memory-tool", "memories")
		);
	});

	test("buildUserMemoryEvaluationPrompt: 生成针对核心记忆的结构化体检 Prompt", () => {
		const content = "# 用户核心记忆\n\n## 沟通\n- 称呼用户为“特哥”。";
		const prompt = buildUserMemoryEvaluationPrompt(content);
		assert.ok(prompt.includes("用户核心记忆文件 (user-preferences.md)"));
		assert.ok(prompt.includes("称呼用户为“特哥”。"));
		assert.ok(prompt.includes("指令有效性与可遵循度"));
		assert.ok(prompt.includes("实证主义与工程防线"));
		assert.ok(prompt.includes("Token 与行数预算效率"));
	});

	test("buildCustomMemoryEvaluationPrompt: 生成针对附加记忆的结构化评估 Prompt", () => {
		const content = "# 自定义附加记忆\n- 每次生成 React 组件使用 TSX";
		const prompt = buildCustomMemoryEvaluationPrompt(content);
		assert.ok(prompt.includes("自定义附加记忆文件 (custom-notes.md)"));
		assert.ok(prompt.includes("每次生成 React 组件使用 TSX"));
		assert.ok(prompt.includes("规则清晰度与针对性"));
		assert.ok(prompt.includes("Token 与行数预算效率"));
	});

	test("buildCombinedMemoryEvaluationPrompt: 生成合并体检与冲突排查 Prompt", () => {
		const userContent = "# 核心记忆\n- 极简回答 1-3 句";
		const customContent = "# 附加记忆\n- 详细罗列所有思考推导";
		const prompt = buildCombinedMemoryEvaluationPrompt(userContent, customContent);
		assert.ok(prompt.includes("合并体检与冲突排查"));
		assert.ok(prompt.includes("用户核心记忆 (user-preferences.md)"));
		assert.ok(prompt.includes("自定义附加记忆 (custom-notes.md)"));
		assert.ok(prompt.includes("规则冲突与自相矛盾检测"));
		assert.ok(prompt.includes("冗余重叠分析"));
		assert.ok(prompt.includes("合计预算与截断风险"));
	});

	test("findOrgInstructionsFilePath: 在组织目录下递归查找 default.instructions.md", () => {
		const tempRoot = path.join(os.tmpdir(), "libiao-test-org-" + Date.now());
		const orgInstructionsDir = path.join(tempRoot, "github.copilot-chat", "github", "testorg", "instructions");
		const targetFile = path.join(orgInstructionsDir, "default.instructions.md");

		fs.mkdirSync(orgInstructionsDir, { recursive: true });
		fs.writeFileSync(targetFile, "# Test Org Instructions", "utf-8");

		try {
			const found = findOrgInstructionsFilePath(tempRoot);
			assert.strictEqual(found, targetFile);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("clearAndLockFile & isFileWritable: 成功清空文件并加锁为只读状态", () => {
		const tempDir = path.join(os.tmpdir(), "libiao-test-lock-" + Date.now());
		const tempFile = path.join(tempDir, "default.instructions.md");
		fs.mkdirSync(tempDir, { recursive: true });
		fs.writeFileSync(tempFile, "# Some unwanted organization instructions\n- rule 1\n- rule 2", "utf-8");

		try {
			assert.strictEqual(isFileWritable(tempFile), true, "初始文件应为可写状态");

			clearAndLockFile(tempFile);

			const contentAfter = fs.readFileSync(tempFile, "utf-8");
			assert.strictEqual(contentAfter, "", "文件内容应被完全清空");
			assert.strictEqual(isFileWritable(tempFile), false, "清空后文件应被设置为只读 (不可写)");
		} finally {
			// 清理前先解锁为可写，以防 rmSync 在 Windows 下权限拒绝
			try {
				fs.chmodSync(tempFile, 0o666);
			} catch (_) {}
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("buildOrgInstructionsEvaluationPrompt: 生成针对组织指令的深度评测 Prompt", () => {
		const sampleOrg = "# 企业 Copilot 规范\n- 必须在每个函数前添加 20 行 JSDoc 注释\n- 禁止使用 any";
		const prompt = buildOrgInstructionsEvaluationPrompt(sampleOrg);
		assert.ok(prompt.includes("组织级全局指令文件 (default.instructions.md)"));
		assert.ok(prompt.includes("必须在每个函数前添加 20 行 JSDoc 注释"));
		assert.ok(prompt.includes("评理与痛点诊断"));
		assert.ok(prompt.includes("潜在副作用与隐式污染"));
		assert.ok(prompt.includes("改造与精简建议"));
		assert.ok(prompt.includes("综合评语与扎心总结"));
	});
});
