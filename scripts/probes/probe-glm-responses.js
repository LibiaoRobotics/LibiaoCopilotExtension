// 探针 4：GLM 系列在 Responses 链路的事件形状（用户截图实际用的是 GLM 5.2）
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

async function probe(model) {
	console.log(`\n########## RESPONSES ${model} ##########`);
	const res = await fetch(`${BASE}/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
		body: JSON.stringify({
			model,
			input: [{ role: "user", content: [{ type: "input_text", text: "一步一步推理：23 乘 47 等于多少？最后只给答案。" }] }],
			stream: true,
		}),
	});
	console.log("HTTP", res.status);
	if (!res.ok) {
		console.log((await res.text()).slice(0, 300));
		return;
	}
	const counts = new Map();
	let out = "";
	let reasoning = "";
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
			const d = line.slice(5).trim();
			if (!d || d === "[DONE]") continue;
			let p;
			try {
				p = JSON.parse(d);
			} catch {
				continue;
			}
			const t = p.type || "(no-type)";
			counts.set(t, (counts.get(t) || 0) + 1);
			if (t === "response.output_text.delta" && typeof p.delta === "string") out += p.delta;
			if (/reasoning|thinking|thought/.test(t) && typeof p.delta === "string") reasoning += p.delta;
		}
	}
	console.log("--- 事件计数 ---");
	for (const [t, c] of counts) console.log(`  ${t}: ${c}`);
	console.log(`output_text 长=${out.length} 含 <think>=${out.includes("<think>")} 含 </think>=${out.includes("</think>")}`);
	console.log("output_text 前 400:", JSON.stringify(out.slice(0, 400)));
	console.log(`reasoning 长=${reasoning.length} 前 150:`, JSON.stringify(reasoning.slice(0, 150)));
}

(async () => {
	for (const m of ["glm-5.2", "glm-5.3", "glm-4.7"]) {
		await probe(m);
	}
})().catch((e) => {
	console.error("probe error:", e);
	process.exit(1);
});
