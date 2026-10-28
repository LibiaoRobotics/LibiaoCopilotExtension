import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// 该文件随 VSIX 分发、由 package.json 的 contributes.chatInstructions 指向。
// 它补的是官方只在 CAPI 端点上才注入的「探索优先委派子智能体」那几行提示；
// 官方那句被 (tools[SearchSubagent] || tools[ExploreSubagent]) 包住，BYOK 下整段消失。
// 内容被改坏不会有任何编译期报错，只能靠这里守住关键约定。
const INSTRUCTION_FILE = path.join(
	__dirname,
	"..",
	"..",
	"assets",
	"instructions",
	"subagent-delegation.instructions.md"
);

interface ParsedInstructionFile {
	frontmatter: string[];
	body: string;
}

function readInstructionFile(): ParsedInstructionFile {
	const markdown = fs.readFileSync(INSTRUCTION_FILE, "utf8");
	const lines = markdown.split(/\r?\n/);
	assert.strictEqual(lines[0], "---", "必须以 frontmatter 起始标记开头");
	const endIndex = lines.indexOf("---", 1);
	assert.notStrictEqual(endIndex, -1, "frontmatter 缺少结束标记");
	return { frontmatter: lines.slice(1, endIndex), body: lines.slice(endIndex + 1).join("\n") };
}

function findLine(frontmatter: string[], prefix: string): string | undefined {
	return frontmatter.find((line) => line.startsWith(prefix));
}

suite("Subagent Delegation Instruction Tests", () => {
	test("指令文件存在且被 package.json 的 contributes.chatInstructions 指向", () => {
		assert.ok(fs.existsSync(INSTRUCTION_FILE), `找不到 ${INSTRUCTION_FILE}`);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
		) as { contributes?: { chatInstructions?: { path?: string }[] } };

		assert.deepStrictEqual(
			(pkg.contributes?.chatInstructions ?? []).map((entry) => entry.path),
			["./assets/instructions/subagent-delegation.instructions.md"],
			"chatInstructions 必须指向本文件，否则委托提示不会进入模型上下文"
		);
	});

	test("applyTo 必须为 **，否则没有任何附件匹配时会被直接跳过", () => {
		const { frontmatter } = readInstructionFile();
		const line = findLine(frontmatter, "applyTo:");
		assert.ok(line, "缺少 applyTo 的指令文件会在 computeAutomaticInstructions 里以 noPattern 被跳过");

		// computeAutomaticInstructions 对 ** / **\/* / * 走特判分支：即使没有附件也注入，
		// 这正是官方那句常驻系统提示的等价行为。
		const pattern = line
			.replace(/^applyTo:\s*/, "")
			.replace(/^["']|["']$/g, "")
			.trim();
		assert.strictEqual(pattern, "**", "只有 ** 能在没有附件时也注入");
	});

	test("正文点名 Explore 与 runSubagent，并要求按名字调用", () => {
		const { body } = readInstructionFile();

		assert.ok(body.includes("`Explore`"), "必须点名 Explore，否则模型不知道派给谁");
		assert.ok(body.includes("`runSubagent`"), "必须点名 runSubagent 工具");
		assert.ok(
			body.includes('agentName: "Explore"'),
			"必须说明用 agentName 按名字调用，省略时 run_subagent 会复制当前智能体"
		);
	});

	test("正文带工具可用性前置条件，避免无该工具的模式被误导", () => {
		const { body } = readInstructionFile();

		assert.ok(
			/When the `runSubagent` tool is available/i.test(body),
			"Ask 模式等场景没有 runSubagent，指令必须先判工具可用，官方那行也是被工具存在性包住的"
		);
	});

	test("正文包含「自己动手」的反向条件，防止过度触发", () => {
		const { body } = readInstructionFile();

		assert.ok(/Do the work yourself when/i.test(body), "缺少反向条件会让简单任务也被委派，反而更慢");
		assert.ok(/only that one file needs reading/i.test(body), "单文件直读不该委派");
		assert.ok(/create, edit or delete files/i.test(body), "改动类任务不该委派给只读子智能体");
	});

	test("正文禁止子智能体再次委派，避免自递归", () => {
		const { body } = readInstructionFile();

		assert.ok(
			/already running inside a subagent, do not delegate again/i.test(body),
			"Explore 的 agents: [] 会让二次委派直接报错，必须在指令层拦住"
		);
	});

	test("正文不引用 BYOK 下被禁用的工具名，避免指向不存在的工具", () => {
		const { body } = readInstructionFile();

		// agentIntent 在非 CAPI 端点会把 Codebase(semantic_search) 一并置 false，
		// 照抄官方原文会写出模型手上没有的工具。
		assert.ok(!/\bCodebase\b/.test(body), "不得引用 BYOK 下已禁用的 Codebase 工具");
		assert.ok(!/semantic_search/.test(body), "不得引用 BYOK 下已禁用的 semantic_search 工具");
	});
});
