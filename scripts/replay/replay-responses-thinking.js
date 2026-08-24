// 复现 harness：真实网关 Responses 流 → 编译产物 OpenaiResponsesApi → 观察输出 part 序列
// 目的：判定"思考被当正文显示"发生在扩展层（输出 TextPart）还是宿主/UI 层（输出 ThinkingPart 但渲染异常）
const Module = require("module");
const path = require("path");
const fs = require("fs");

// ---- vscode shim ----
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
	version: "1.134.0",
	workspace: {
		getConfiguration: () => ({ get: (_k, def) => def, has: () => false, update: async () => {} }),
	},
	extensions: { getExtension: () => undefined },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
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
const { OpenaiResponsesApi } = require(path.join(OUT, "openai", "openaiResponsesApi.js"));

function resolveApiKey() {
	if (process.env.LIBIAO_API_KEY) return process.env.LIBIAO_API_KEY;
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
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
const PROMPT = "一步一步推理：23 乘 47 等于多少？最后只给答案。";

async function main() {
	const model = process.argv[2] || "qwen3.8-max";
	console.log(`===== 拉取真实流: ${model} =====`);
	const res = await fetch(`${BASE}/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
		body: JSON.stringify({
			model,
			input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
			stream: true,
			reasoning: { effort: "high" },
		}),
	});
	if (!res.ok) {
		console.log("HTTP", res.status, (await res.text()).slice(0, 300));
		process.exit(1);
	}

	// 收集原始 SSE data 行
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
	const firstReasoning = rawEvents.find((d) => d.includes("reasoning_text.delta") || d.includes("reasoning.delta"));
	console.log("首个 reasoning 事件原文:", firstReasoning ? firstReasoning.slice(0, 300) : "(无)");

	// ---- 回放进编译产物 ----
	const { ReadableStream } = require("stream/web");
	const sseText = rawEvents.map((d) => `data: ${d}\n\n`).join("");
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(sseText));
			controller.close();
		},
	});

	const api = new OpenaiResponsesApi(model);
	const parts = [];
	const progress = { report: (p) => parts.push(p) };
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

	await api.processStreamingResponse(stream, progress, token);

	// ---- 分类输出 ----
	console.log(`\n===== 扩展层输出 part 序列（共 ${parts.length} 个）=====`);
	let thinkingLen = 0;
	let textLen = 0;
	let thinkingPreview = "";
	let textPreview = "";
	for (const p of parts) {
		if (p instanceof LanguageModelThinkingPart) {
			const v = Array.isArray(p.value) ? p.value.join("") : p.value || "";
			thinkingLen += v.length;
			if (!thinkingPreview && v) thinkingPreview = v;
			console.log(`  [THINKING] len=${v.length} id=${p.id ?? "(无)"} 预览=${JSON.stringify(v.slice(0, 60))}`);
		} else if (p instanceof LanguageModelTextPart) {
			textLen += (p.value || "").length;
			if (!textPreview && p.value) textPreview = p.value;
			console.log(`  [TEXT]     len=${(p.value || "").length} 预览=${JSON.stringify((p.value || "").slice(0, 60))}`);
		} else if (p instanceof LanguageModelToolCallPart) {
			console.log(`  [TOOLCALL] ${p.name}`);
		} else if (p instanceof LanguageModelDataPart) {
			console.log(`  [DATA]     mime=${p.mimeType}`);
		} else {
			console.log(`  [OTHER]    ${p?.constructor?.name}`);
		}
	}
	console.log(`\n汇总: thinking=${thinkingLen} 字符, text=${textLen} 字符`);
	console.log("thinking 预览:", JSON.stringify(thinkingPreview.slice(0, 150)));
	console.log("text 预览:", JSON.stringify(textPreview.slice(0, 150)));
	if (thinkingLen > 0 && textLen < thinkingLen) {
		console.log("\n结论: 扩展层正确分流（思考→ThinkingPart，正文→TextPart）→ 问题在宿主/UI 渲染层或运行实例未重载");
	} else if (thinkingLen === 0 && textLen > 0) {
		console.log("\n结论: 扩展层把思考当正文输出了 → 扩展层 bug，继续深挖 processEvent");
	}
}

main().catch((e) => {
	console.error("replay error:", e);
	process.exit(1);
});
