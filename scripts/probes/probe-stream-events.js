// 原始 SSE 事件探针（优先环境变量；若无则从 glm53-effort-test.js 读取）
// 目的：
//  1) Responses 链路：思考内容到底走哪类事件？output_text 里是否带 <think> 类标签？
//  2) Anthropic 链路：message_start / message_delta 的 usage 字段形状；thinking 走什么事件？
const fs = require("fs");
const path = require("path");

function resolveApiKey() {
	if (process.env.LIBIAO_API_KEY) return process.env.LIBIAO_API_KEY;
	const probeCandidates = [
		path.join(__dirname, "glm53-effort-test.js"),
		path.join(__dirname, "..", "probes", "glm53-effort-test.js"),
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
const BASE = process.env.LIBIAO_BASE_URL || "https://newapi.libiaorobot.com/v1";
const PROMPT = "一步一步推理：23 乘 47 等于多少？最后只给答案。";

async function* sseLines(res) {
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
			if (line.startsWith("data:")) yield line.slice(5).trim();
		}
	}
}

async function probeResponses(model) {
	console.log(`\n########## RESPONSES ${model} ##########`);
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
	console.log("HTTP", res.status);
	if (!res.ok) {
		console.log((await res.text()).slice(0, 400));
		return;
	}
	const counts = new Map();
	let outputText = "";
	let reasoningText = "";
	let outputTextFirst = "";
	for await (const data of sseLines(res)) {
		if (!data || data === "[DONE]") continue;
		let p;
		try {
			p = JSON.parse(data);
		} catch {
			continue;
		}
		const t = p.type || "(no-type)";
		counts.set(t, (counts.get(t) || 0) + 1);
		if (t === "response.output_text.delta" && typeof p.delta === "string") {
			if (!outputTextFirst) outputTextFirst = p.delta;
			outputText += p.delta;
		}
		if (/reasoning|thinking|thought/.test(t)) {
			const d = typeof p.delta === "string" ? p.delta : typeof p.text === "string" ? p.text : "";
			reasoningText += d;
		}
	}
	console.log("--- 事件类型计数 ---");
	for (const [t, c] of counts) console.log(`  ${t}: ${c}`);
	console.log("--- output_text 首 delta（前120字符，看有无标签/前导空白）---");
	console.log(JSON.stringify(outputTextFirst.slice(0, 120)));
	console.log("--- output_text 全文前 300 字符 ---");
	console.log(outputText.slice(0, 300));
	console.log("--- reasoning 类事件累计前 200 字符 ---");
	console.log(reasoningText.slice(0, 200));
	console.log(`output_text 含 <think>: ${outputText.includes("<think>")}  含 </think>: ${outputText.includes("</think>")}`);
}

async function probeAnthropic(model) {
	console.log(`\n########## ANTHROPIC ${model} ##########`);
	const res = await fetch(`${BASE}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({
			model,
			max_tokens: 8192,
			stream: true,
			messages: [{ role: "user", content: PROMPT }],
		}),
	});
	console.log("HTTP", res.status);
	if (!res.ok) {
		console.log((await res.text()).slice(0, 400));
		return;
	}
	const counts = new Map();
	let firstThinking = "";
	let firstText = "";
	let textAll = "";
	for await (const data of sseLines(res)) {
		if (!data || data === "[DONE]") continue;
		let p;
		try {
			p = JSON.parse(data);
		} catch {
			continue;
		}
		const t = p.type || "(no-type)";
		counts.set(t, (counts.get(t) || 0) + 1);
		if (t === "message_start") console.log("message_start.usage =", JSON.stringify(p.message?.usage));
		if (t === "message_delta") console.log("message_delta.usage =", JSON.stringify(p.usage));
		if (t === "content_block_delta") {
			if (p.delta?.type === "thinking_delta" && !firstThinking) firstThinking = p.delta.thinking || "";
			if (p.delta?.type === "text_delta") {
				if (!firstText) firstText = p.delta.text || "";
				textAll += p.delta.text || "";
			}
		}
	}
	console.log("--- 事件类型计数 ---");
	for (const [t, c] of counts) console.log(`  ${t}: ${c}`);
	console.log("--- 首 thinking_delta 前 150 字符 ---");
	console.log(JSON.stringify(firstThinking.slice(0, 150)));
	console.log("--- 首 text_delta 前 150 字符 ---");
	console.log(JSON.stringify(firstText.slice(0, 150)));
	console.log(`text 全文含 <think>: ${textAll.includes("<think>")}  含 </think>: ${textAll.includes("</think>")}  text 总长: ${textAll.length}`);
}

(async () => {
	await probeResponses("qwen3.8-max");
	await probeResponses("deepseek-v4-pro");
	await probeAnthropic("glm-5.3");
})().catch((e) => {
	console.error("probe error:", e);
	process.exit(1);
});
