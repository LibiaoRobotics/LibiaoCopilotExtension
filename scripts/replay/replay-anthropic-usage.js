// 复现 harness：glm-5.2 Anthropic 真实流 → 编译产物 AnthropicApi → 验证 usage 捕获与 part 分流
const Module = require("module");
const path = require("path");
const fs = require("fs");

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelThinkingPart {
	constructor(value, id, metadata) {
		this.value = value;
		this.id = id;
		this.metadata = metadata;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
const shim = {
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelToolCallPart,
	LanguageModelDataPart,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
	version: "1.134.0",
	workspace: { getConfiguration: () => ({ get: (_k, def) => def }) },
	extensions: { getExtension: () => undefined },
};
const origLoad = Module._load;
Module._load = function (request) {
	if (request === "vscode") {
		return shim;
	}
	return origLoad.apply(this, arguments);
};

const outCandidates = [
	path.join(__dirname, "..", "..", "out"),
	path.join(__dirname, "..", "libiao-copilot", "out"),
];
const OUT = outCandidates.find((p) => fs.existsSync(p)) || outCandidates[0];
const { AnthropicApi } = require(path.join(OUT, "anthropic", "anthropicApi.js"));

function resolveApiKey() {
	if (process.env.LIBIAO_API_KEY) return process.env.LIBIAO_API_KEY;
	if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
	const probeCandidates = [
		path.join(__dirname, "..", "probes", "glm53-effort-test.js"),
		path.join(__dirname, "glm53-effort-test.js"),
	];
	for (const p of probeCandidates) {
		if (fs.existsSync(p)) {
			const m = fs.readFileSync(p, "utf8").match(/const KEY = "([^"]+)"/);
			if (m) return m[1];
		}
	}
	throw new Error("未找到 API Key，请设置环境变量 LIBIAO_API_KEY");
}
const KEY = resolveApiKey();
const BASE = "https://newapi.libiaorobot.com/v1";

async function main() {
	const model = "glm-5.2";
	console.log(`===== 拉取真实流: ANTHROPIC ${model} =====`);
	const res = await fetch(`${BASE}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({
			model,
			max_tokens: 8192,
			stream: true,
			messages: [{ role: "user", content: "一步一步推理：23 乘 47 等于多少？最后只给答案。" }],
		}),
	});
	if (!res.ok) {
		console.log("HTTP", res.status, (await res.text()).slice(0, 300));
		process.exit(1);
	}

	const rawEvents = [];
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() || "";
		for (const line of lines) {
			if (line.startsWith("data:")) {
				const d = line.slice(5).trim();
				if (d && d !== "[DONE]") rawEvents.push(d);
			}
		}
	}
	console.log("原始事件数:", rawEvents.length);

	const { ReadableStream } = require("stream/web");
	const sseText = rawEvents.map((d) => `data: ${d}\n\n`).join("");
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(sseText));
			controller.close();
		},
	});

	const api = new AnthropicApi(model, false);
	const parts = [];
	const progress = { report: (p) => parts.push(p) };
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

	await api.processStreamingResponse(stream, progress, token);

	let thinkingLen = 0;
	let textLen = 0;
	for (const p of parts) {
		if (p instanceof LanguageModelThinkingPart) {
			thinkingLen += (Array.isArray(p.value) ? p.value.join("") : p.value || "").length;
		} else if (p instanceof LanguageModelTextPart) {
			textLen += (p.value || "").length;
		}
	}
	const usage = api.getUsage();
	console.log(`\n===== 结果 =====`);
	console.log("usage:", JSON.stringify(usage));
	console.log(`part 分流: thinking=${thinkingLen} 字符, text=${textLen} 字符`);
	const ok =
		usage &&
		usage.prompt_tokens === 31 &&
		usage.completion_tokens > 0 &&
		thinkingLen > 0 &&
		textLen > 0;
	console.log("判定:", ok ? "✅ usage 宽容合并生效（prompt=31 取自 message_delta）且思考/正文分流正确" : "❌ 需检查");
}

main().catch((e) => {
	console.error("replay error:", e);
	process.exit(1);
});
