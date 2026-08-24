// 用「reasoning 全文反引号奇偶」作守卫触发信号的区分度验证
// 用法: node scripts/analyze-backtick-balance.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let curId = null;
const byResp = new Map();

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
	const e = byResp.get(curId) ?? { reasoning: "", open: false, close: false };
	if (ev.type === "response.reasoning_text.delta" && typeof ev.delta === "string") e.reasoning += ev.delta;
	if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
		if (ev.delta.includes("<think>")) e.open = true;
		if (ev.delta.includes("</think>")) e.close = true;
	}
	byResp.set(curId, e);
});

rl.on("close", () => {
	let la = 0, lt = 0, na = 0, nt = 0;
	for (const [id, e] of byResp) {
		if (!e.reasoning) continue;
		const odd = ((e.reasoning.match(/`/g) || []).length % 2) === 1;
		const leak = e.close && !e.open;
		if (leak) { lt++; if (odd) la++; }
		else { nt++; if (odd) na++; }
	}
	console.log(`泄漏回合 ${lt}，反引号失衡触发: ${la}`);
	console.log(`正常回合 ${nt}，反引号失衡误报: ${na}（误报率 ${(100 * na / Math.max(1, nt)).toFixed(1)}%）`);
});
