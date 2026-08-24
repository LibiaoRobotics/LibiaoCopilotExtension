// 抓取 glm-5.2 真实流的 content_block_delta 全量事件序列，存成 JSON 供解析器回放
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
const HEADERS = { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" };

(async () => {
	const res = await fetch(`${BASE}/messages`, {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify({
			model: "glm-5.2",
			max_tokens: 4096,
			stream: true,
			thinking: { type: "enabled", budget_tokens: 2048 },
			system: [{ type: "text", text: "You are a coding assistant.", cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: "写一个带泛型和比较运算符 `<` 的 TypeScript 快排函数，并用 3 句话解释，其中要出现 `<` 和 `<think` 这种字面量。" }],
		}),
	});
	console.log("HTTP", res.status);
	if (!res.ok) { console.log((await res.text()).slice(0, 400)); return; }
	const events = [];
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
			// 只保留对解析器有影响的事件：content_block_delta / content_block_start/stop / message_stop
			if (["content_block_start", "content_block_delta", "content_block_stop", "message_stop"].includes(p.type)) {
				events.push(p);
			}
		}
	}
	const outPath = path.join(__dirname, "..", "replay", "glm52-stream-events.json");
	fs.writeFileSync(outPath, JSON.stringify(events, null, 0));
	// 统计
	const textDeltas = events.filter(e => e.type === "content_block_delta" && e.delta?.type === "text_delta");
	const thinkDeltas = events.filter(e => e.type === "content_block_delta" && e.delta?.type === "thinking_delta");
	const totalText = textDeltas.reduce((a, e) => a + (e.delta.text?.length || 0), 0);
	console.log("事件总数:", events.length, "| text_delta:", textDeltas.length, `(${totalText} 字符)`, "| thinking_delta:", thinkDeltas.length);
	console.log("text 是否含 < :", textDeltas.some(e => (e.delta.text || "").includes("<")));
	console.log("text 是否含 <think :", textDeltas.some(e => (e.delta.text || "").includes("<think")));
	console.log("已保存 → " + outPath);
})().catch(e => { console.error(e); process.exit(1); });
