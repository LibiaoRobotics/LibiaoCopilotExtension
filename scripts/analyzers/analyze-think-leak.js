// 统计「正文通道含 </think> 但无 <think>」的 response 数量（思考泄漏指标）
// 用法: node scripts/analyze-think-leak.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let curId = null;
const byResp = new Map(); // respId -> { open: bool, close: bool, reasoning: bool, ts }

rl.on("line", (line) => {
	if (!line.includes("responses.stream.chunk")) return;
	let obj;
	try { obj = JSON.parse(line); } catch { return; }
	const dataStr = obj.data && obj.data.data;
	if (!dataStr) return;
	let ev;
	try { ev = JSON.parse(dataStr); } catch { return; }
	const respId = ev.response && typeof ev.response.id === "string" ? ev.response.id : null;
	if (respId) curId = respId;
	if (!curId) return;
	const e = byResp.get(curId) ?? { open: false, close: false, reasoning: false, ts: obj.ts };
	if (ev.type === "response.reasoning_text.delta" || ev.type === "response.reasoning.delta") e.reasoning = true;
	if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
		if (ev.delta.includes("<think>")) e.open = true;
		if (ev.delta.includes("</think>")) e.close = true;
	}
	byResp.set(curId, e);
});

rl.on("close", () => {
	let leak = 0;
	const leaks = [];
	for (const [id, e] of byResp) {
		if (e.close && !e.open) {
			leak++;
			leaks.push(`${e.ts} ${id} reasoning=${e.reasoning}`);
		}
	}
	console.log(`总 response: ${byResp.size}`);
	console.log(`正文含 </think> 无 <think>（泄漏）: ${leak}`);
	leaks.forEach((l) => console.log("  " + l));
});
