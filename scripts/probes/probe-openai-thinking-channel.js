// 取证:openai 模式(chat completions)模型经网关时,思考走哪个通道?
// 原生字段(reasoning_content/thinking)还是 content 内联 <think> 标签?
const fs = require("fs");
const path = require("path");

function resolveApiKey() {
	if (process.env.LIBIAO_API_KEY) return process.env.LIBIAO_API_KEY;
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
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

const MODELS = ["gemini-3.1-pro-preview", "claude-sonnet-5", "MiniMax-M3"];

async function probe(model) {
	console.log("\n########## " + model + " ##########");
	let res;
	try {
		res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
			body: JSON.stringify({
				model,
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "一步一步推理:23 乘 47 等于多少?最后只给答案。" }],
			}),
			signal: AbortSignal.timeout(90000),
		});
	} catch (e) { console.log("fetch 异常:", e.name, e.message); return; }
	console.log("HTTP", res.status);
	if (!res.ok) { console.log((await res.text()).slice(0, 300)); return; }

	let contentAll = "", rcAll = "", thinkingField = "", otherFields = new Set();
	let sawContent = false, sawRc = false;
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
			if (!line.startsWith("data:")) continue;
			const raw = line.slice(5).trim();
			if (!raw || raw === "[DONE]") continue;
			let p; try { p = JSON.parse(raw); } catch { continue; }
			const choice = (p.choices || [])[0];
			const d = choice && choice.delta;
			if (!d) continue;
			for (const k of Object.keys(d)) {
				if (k !== "content" && k !== "role" && d[k] !== null && d[k] !== undefined && d[k] !== "") otherFields.add(k);
			}
			if (typeof d.content === "string" && d.content) { sawContent = true; contentAll += d.content; }
			for (const f of ["reasoning_content", "thinking", "reasoning"]) {
				if (typeof d[f] === "string" && d[f]) { sawRc = true; rcAll += d[f]; thinkingField = f; }
			}
		}
	}
	console.log("content delta:", sawContent, "(" + contentAll.length + " 字符)",
		"| 原生思考字段:", sawRc ? thinkingField : "无", "(" + rcAll.length + " 字符)");
	console.log("content 含 <think:", contentAll.includes(String.fromCharCode(60) + "think"));
	console.log("delta 其他字段:", [...otherFields].join(",") || "(无)");
	console.log("content 前 120:", JSON.stringify(contentAll.slice(0, 120)));
}

(async () => {
	for (const m of MODELS) await probe(m);
})().catch(e => { console.error(e); process.exit(1); });
