import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface SessionInfo {
	title: string;
	selectedModel: string;
	credits: number | null;
}

const templatePath = path.resolve(__dirname, "../../assets/hooks/WechatNotify.ps1");
const readSessionCommand = `
$ErrorActionPreference = 'Stop'
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:LIBIAO_TEST_TEMPLATE, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-ModelName', 'Get-LastCredits', 'Read-SessionState', 'Get-SessionInfo')) {
	$functionAst = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
	. ([scriptblock]::Create($functionAst.Extent.Text))
}
function Write-WechatNotifyLog([string] $Message) { throw $Message }
$info = Get-SessionInfo $env:LIBIAO_TEST_TRANSCRIPT 'session'
ConvertTo-Json -InputObject $info -Compress -Depth 10
`;

suite("WechatNotify session credits", () => {
	let fixtureRoot: string;

	suiteSetup(() => {
		fixtureRoot = fs.mkdtempSync(path.join(__dirname, "wechat-notify-"));
		fs.mkdirSync(path.join(fixtureRoot, "chatSessions"));
	});

	suiteTeardown(() => {
		fs.rmSync(fixtureRoot, { recursive: true, force: true });
	});

	function readSession(entries: unknown[], format = "jsonl"): SessionInfo {
		const logPath = path.join(fixtureRoot, "chatSessions", `session.${format}`);
		const text = format === "json" ? JSON.stringify(entries[0]) : entries.map(entry => JSON.stringify(entry)).join("\n");
		fs.writeFileSync(logPath, `\uFEFF${text}`, "utf8");
		try {
			const output = execFileSync("pwsh", [
				"-NoProfile", "-NonInteractive", "-EncodedCommand",
				Buffer.from(readSessionCommand, "utf16le").toString("base64"),
			], {
				encoding: "utf8",
				timeout: 15000,
				env: {
					...process.env,
					LIBIAO_TEST_TEMPLATE: templatePath,
					LIBIAO_TEST_TRANSCRIPT: path.join(fixtureRoot, "transcripts", "session.jsonl"),
				},
			});
			return JSON.parse(output.trim()) as SessionInfo;
		} finally {
			fs.unlinkSync(logPath);
		}
	}

	function snapshot(requests: unknown[] = [{ copilotCredits: 3 }, {}]) {
		return {
			kind: 0,
			v: {
				customTitle: "Fixture session",
				inputState: { selectedModel: { metadata: { name: "Official model" } } },
				requests,
			},
		};
	}

	test("template retains UTF-8 BOM", () => {
		assert.deepStrictEqual([...fs.readFileSync(templatePath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
	});

	test("reads credits, title and model from a complete snapshot", () => {
		assert.deepStrictEqual(readSession([snapshot([{ copilotCredits: 12.5 }])]), {
			title: "Fixture session", selectedModel: "Official model", credits: 12.5,
		});
	});

	test("reads the latest credit property patch instead of an older turn", () => {
		const info = readSession([
			snapshot(),
			{ kind: 1, k: ["requests", 1, "copilotCredits"], v: 4 },
			{ kind: 1, k: ["requests", 1, "copilotCredits"], v: 12.5 },
		]);
		assert.strictEqual(info.credits, 12.5);
	});

	test("does not fall back to previous turn when current usage is missing", () => {
		assert.strictEqual(readSession([snapshot()]).credits, null);
	});

	test("preserves zero credits", () => {
		assert.strictEqual(readSession([
			snapshot(), { kind: 1, k: ["requests", 1, "copilotCredits"], v: 0 },
		]).credits, 0);
	});

	test("reads credits from an appended request", () => {
		assert.strictEqual(readSession([
			snapshot(), { kind: 2, k: ["requests"], v: [{ copilotCredits: 4.25 }] },
		]).credits, 4.25);
	});

	test("applies request truncation and replacement", () => {
		assert.strictEqual(readSession([
			snapshot(), { kind: 2, k: ["requests"], i: 1, v: [{ copilotCredits: 9 }] },
		]).credits, 9);
	});

	test("applies request truncation without appended values", () => {
		assert.strictEqual(readSession([
			snapshot(), { kind: 2, k: ["requests"], i: 1 },
		]).credits, 3);
	});

	test("does not retain a deleted credits property", () => {
		assert.strictEqual(readSession([
			snapshot([{ copilotCredits: 12.5 }]),
			{ kind: 3, k: ["requests", 0, "copilotCredits"] },
		]).credits, null);
	});

	test("does not mistake response content for request usage", () => {
		assert.strictEqual(readSession([
			snapshot([{ copilotCredits: 12.5, response: [{ copilotCredits: 999 }] }]),
		]).credits, 12.5);
	});

	test("uses a replacement snapshot rather than stale state", () => {
		assert.strictEqual(readSession([
			snapshot([{ copilotCredits: 12.5 }]), snapshot([{}]),
		]).credits, null);
	});

	test("applies title and selected model patches", () => {
		const info = readSession([
			snapshot(),
			{ kind: 1, k: ["customTitle"], v: "Updated title" },
			{ kind: 1, k: ["inputState", "selectedModel", "metadata", "name"], v: "Updated model" },
		]);
		assert.strictEqual(info.title, "Updated title");
		assert.strictEqual(info.selectedModel, "Updated model");
	});

	test("supports legacy flat JSON storage", () => {
		assert.strictEqual(readSession([snapshot([{ copilotCredits: 6.25 }]).v], "json").credits, 6.25);
	});

	test("does not fall back to previous turn in flat JSON storage", () => {
		assert.strictEqual(readSession([snapshot().v], "json").credits, null);
	});

	test("returns no credits for an empty request list", () => {
		assert.strictEqual(readSession([snapshot([])]).credits, null);
	});

	test("does not coerce a boolean into credits", () => {
		assert.strictEqual(readSession([snapshot([{ copilotCredits: true }])]).credits, null);
	});
});