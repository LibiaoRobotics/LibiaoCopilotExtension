// 探针 2：带 tools 的 Responses 流，验证 agent 场景下思考是否仍走 reasoning 事件
// （对比无 tools 探针：reasoning_text.delta 独立、output_text 干净）
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
	console.log(`\n########## RESPONSES+TOOLS ${model} ##########`);
	const res = await fetch(`${BASE}/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
		body: JSON.stringify({
			model,
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "请先认真思考（务必使用工具查询），然后用 get_time 工具获取当前时间相关的信息，再回答：现在大概是几点？",
						},
					],
				},
			],
			tools: [
				{
					type: "function",
					name: "get_time",
					description: "获取当前时间",
					parameters: { type: "object", properties: { timezone: { type: "string" } } },
				},
			],
			stream: true,
			reasoning: { effort: "high" },
			reasoning_effort: "high",
		}),
	});
	console.log("HTTP", res.status);
	if (!res.ok) {
		console.log((await res.text()).slice(0, 300));
		return;
	}
	const counts = new Map();
	let outputText = "";
	let reasoningText = "";
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
			if (t === "response.output_text.delta" && typeof p.delta === "string") outputText += p.delta;
			if (/reasoning|thinking|thought/.test(t) && typeof p.delta === "string") reasoningText += p.delta;
		}
	}
	console.log("--- 事件计数 ---");
	for (const [t, c] of counts) console.log(`  ${t}: ${c}`);
	console.log(`output_text 长=${outputText.length} 含 <think>=${outputText.includes("<think>")} 含 </think>=${outputText.includes("</think>")}`);
	console.log("output_text 前 400:", JSON.stringify(outputText.slice(0, 400)));
	console.log(`reasoning 长=${reasoningText.length} 前 150:`, JSON.stringify(reasoningText.slice(0, 150)));
}

(async () => {
	await probe("qwen3.8-max");
	await probe("deepseek-v4-pro");
})().catch((e) => {
	console.error("probe error:", e);
	process.exit(1);
});
