import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// 该文件随 VSIX 分发、由 package.json 的 contributes.chatAgents 直接指向，
// 内容被改坏不会有任何编译期报错，只能靠这里守住格式与只读约束。
const AGENT_FILE = path.join(__dirname, "..", "..", "assets", "agents", "Explore.agent.md");

interface ParsedAgentFile {
	frontmatter: string[];
	body: string;
}

function readAgentFile(): ParsedAgentFile {
	const markdown = fs.readFileSync(AGENT_FILE, "utf8");
	const lines = markdown.split(/\r?\n/);
	assert.strictEqual(lines[0], "---", "必须以 frontmatter 起始标记开头");
	const endIndex = lines.indexOf("---", 1);
	assert.notStrictEqual(endIndex, -1, "frontmatter 缺少结束标记");
	return { frontmatter: lines.slice(1, endIndex), body: lines.slice(endIndex + 1).join("\n") };
}

function findLine(frontmatter: string[], prefix: string): string | undefined {
	return frontmatter.find((line) => line.startsWith(prefix));
}

suite("Explore Agent File Tests", () => {
	test("Explore.agent.md 存在且被 package.json 的 contributes.chatAgents 指向", () => {
		assert.ok(fs.existsSync(AGENT_FILE), `找不到 ${AGENT_FILE}`);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
		) as { contributes?: { chatAgents?: { path?: string }[] } };

		assert.deepStrictEqual(
			(pkg.contributes?.chatAgents ?? []).map((entry) => entry.path),
			["./assets/agents/Explore.agent.md"],
			"chatAgents 必须指向本文件，否则智能体不会被发现"
		);
	});

	test("Explore.agent.md: frontmatter 结构完整", () => {
		const { frontmatter, body } = readAgentFile();

		assert.ok(frontmatter.length > 0, "frontmatter 不应为空");
		assert.ok(body.trim().length > 0, "正文不应为空");
	});

	test("Explore.agent.md: 名字为 Explore，runSubagent 按名字查找", () => {
		const { frontmatter } = readAgentFile();
		assert.strictEqual(findLine(frontmatter, "name: "), "name: Explore");
	});

	test("Explore.agent.md: 隐藏于用户下拉，但仍可被主智能体调用", () => {
		const { frontmatter } = readAgentFile();

		assert.ok(frontmatter.includes("user-invocable: false"), "user-invocable: false 让用户下拉不出现它");
		assert.ok(
			!frontmatter.some((line) => line.startsWith("disable-model-invocation")),
			"不得设置 disable-model-invocation，否则 agentInvocable 变 false，主智能体无法调用"
		);
		assert.strictEqual(findLine(frontmatter, "agents:"), "agents: []", "禁止 Explore 再递归派生子智能体");
	});

	test("Explore.agent.md: 不写 model，交给 runSubagent 继承主会话模型", () => {
		const { frontmatter } = readAgentFile();

		assert.ok(
			!frontmatter.some((line) => line.startsWith("model:")),
			"BYOK 模型名由用户配置与网关探测决定，硬编码 model 会导致解析不到"
		);
	});

	test("Explore.agent.md: 工具集只读，不包含编辑/终端执行/嵌套子智能体能力", () => {
		const { frontmatter } = readAgentFile();
		const toolsLine = findLine(frontmatter, "tools: ");
		assert.ok(toolsLine, "必须声明 tools");

		for (const forbidden of ["'edit'", "'execute'", "'agent'", "'todo'"]) {
			assert.ok(!toolsLine.includes(forbidden), `只读子智能体不得声明 ${forbidden}`);
		}
		for (const required of ["'search'", "'read'"]) {
			assert.ok(toolsLine.includes(required), `探索能力依赖核心工具集 ${required}`);
		}
	});

	test("Explore.agent.md: 含单引号的说明文字被双引号包裹，不破坏 YAML", () => {
		const { frontmatter } = readAgentFile();

		const argumentHint = findLine(frontmatter, "argument-hint: ");
		assert.ok(argumentHint, "必须声明 argument-hint");
		assert.ok(argumentHint.endsWith('"'), "含单引号的文案必须整体加双引号");
		assert.ok(argumentHint.includes("you're"), "文案应保持原样");

		const description = findLine(frontmatter, "description: ");
		assert.ok(description, "必须声明 description");
		assert.ok(description.endsWith('"'), "描述统一加双引号，避免文案里出现冒号后破坏结构");
	});

	test("Explore.agent.md: 正文包含分层搜索策略、并行原则与输出约定", () => {
		const { body } = readAgentFile();

		assert.ok(body.includes("## Search Strategy"), "缺少搜索策略段");
		assert.ok(body.includes("## Speed Principles"), "缺少并行/速度原则段");
		assert.ok(body.includes("## Output"), "缺少输出约定段");
		assert.ok(body.includes("read-only"), "必须显式声明只读约束");
		assert.ok(!body.includes("github repo tool"), "未声明 github 工具时不得在正文里要求模型调用它");
	});
});
