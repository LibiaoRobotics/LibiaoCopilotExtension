// 统计 reasoning 通道结尾字符形态：泄漏回合 vs 正常回合
// 假设：泄漏回合的 reasoning 在「未完成 token」处被切断（如开引号/开括号/半截词），
// 正常回合的 reasoning 以完整句子结尾。若区分度好，可作插件侧修复的触发信号。
// 用法: node scripts/analyze-reasoning-tail.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let curId = null;
const byResp = new Map(); // respId -> { reasoning: string, outOpen: bool, outClose: bool }

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
	const e = byResp.get(curId) ?? { reasoning: "", outOpen: false, outClose: false };
	if (ev.type === "response.reasoning_text.delta" && typeof ev.delta === "string") e.reasoning += ev.delta;
	if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
		if (ev.delta.includes("<think>")) e.outOpen = true;
		if (ev.delta.includes("</think>")) e.outClose = true;
	}
	byResp.set(curId, e);
});

rl.on("close", () => {
	const TERMINALS = new Set([".", "!", "?", "。", "！", "？"]);
	let leakAbrupt = 0, leakTotal = 0, normalAbrupt = 0, normalTotal = 0;
	for (const [id, e] of byResp) {
		if (!e.reasoning) continue;
		const tail = e.reasoning.trimEnd();
		const last = tail.slice(-1);
		const abrupt = !TERMINALS.has(last);
		const leak = e.outClose && !e.outOpen;
		if (leak) {
			leakTotal++;
			if (abrupt) leakAbrupt++;
			console.log(`[LEAK] ${id} abrupt=${abrupt} tail=${JSON.stringify(tail.slice(-50))}`);
		} else {
			normalTotal++;
			if (abrupt) normalAbrupt++;
		}
	}
	console.log(`\n泄漏回合: ${leakTotal}，其中 reasoning 结尾不完整: ${leakAbrupt}`);
	console.log(`正常回合: ${normalTotal}，其中 reasoning 结尾不完整: ${normalAbrupt}（误报率 ${(100 * normalAbrupt / Math.max(1, normalTotal)).toFixed(1)}%）`);
});
