// 探针 5：glm-5.2 走 Anthropic 端点，取证 usage 形状与思考事件形态
// （glm-5.3 当日限额，glm-5.2 同族可替代取证）
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/glm53-effort-test.js", "utf8");
const KEY = src.match(/const KEY = "([^"]+)"/)[1];
const BASE = "https://newapi.libiaorobot.com/v1";

async function probe(model) {
	console.log(`\n########## ANTHROPIC ${model} ##########`);
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
	console.log("HTTP", res.status);
	if (!res.ok) {
		console.log((await res.text()).slice(0, 400));
		return;
	}
	const counts = new Map();
	let firstThinking = "";
	let firstText = "";
	let textAll = "";
	let thinkingAll = "";
	for await (const raw of (async function* () {
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
	})()) {
		if (!raw || raw === "[DONE]") continue;
		let p;
		try {
			p = JSON.parse(raw);
		} catch {
			continue;
		}
		const t = p.type || "(no-type)";
		counts.set(t, (counts.get(t) || 0) + 1);
		if (t === "message_start") console.log("message_start.usage =", JSON.stringify(p.message?.usage));
		if (t === "message_delta") console.log("message_delta.usage =", JSON.stringify(p.usage));
		if (t === "content_block_start") console.log("content_block_start.type =", p.content_block?.type);
		if (t === "content_block_delta") {
			if (p.delta?.type === "thinking_delta") {
				if (!firstThinking) firstThinking = p.delta.thinking || "";
				thinkingAll += p.delta.thinking || "";
			}
			if (p.delta?.type === "text_delta") {
				if (!firstText) firstText = p.delta.text || "";
				textAll += p.delta.text || "";
			}
		}
	}
	console.log("--- 事件计数 ---");
	for (const [t, c] of counts) console.log(`  ${t}: ${c}`);
	console.log(`thinking 长=${thinkingAll.length} 首段:`, JSON.stringify(firstThinking.slice(0, 150)));
	console.log(`text 长=${textAll.length} 含 <think>=${textAll.includes("<think>")}`);
	console.log("text 前 250:", JSON.stringify(textAll.slice(0, 250)));
}

(async () => {
	await probe("glm-5.2");
})().catch((e) => {
	console.error("probe error:", e);
	process.exit(1);
});
