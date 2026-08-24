// 统计「function_call 流式 delta 累积参数 ≠ done 权威参数」的频率（网关污染指标）
// 用法: node scripts/analyze-delta-vs-done.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let curId = null;
const acc = new Map(); // item_id -> { deltas: string, done: string|null, name, respId, ts }

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
	const itemId = ev.item_id;
	if (!itemId) return;
	if (ev.type === "response.function_call_arguments.delta") {
		const e = acc.get(itemId) ?? { deltas: "", done: null, name: ev.name ?? "?", respId: curId, ts: obj.ts };
		e.deltas += typeof ev.delta === "string" ? ev.delta : "";
		acc.set(itemId, e);
	}
	if (ev.type === "response.function_call_arguments.done") {
		const e = acc.get(itemId) ?? { deltas: "", done: null, name: ev.name ?? "?", respId: curId, ts: obj.ts };
		e.done = typeof ev.arguments === "string" ? ev.arguments : "";
		e.name = ev.name ?? e.name;
		acc.set(itemId, e);
	}
});

rl.on("close", () => {
	let mismatch = 0, withDone = 0, emptyDone = 0;
	for (const [id, e] of acc) {
		if (e.done === null) continue;
		withDone++;
		if (!e.done) { emptyDone++; continue; }
		if (e.deltas && e.done !== e.deltas) {
			mismatch++;
			console.log(`MISMATCH ${e.ts} ${e.respId} | ${e.name}\n  delta累积: ${e.deltas.slice(0, 150)}\n  done权威: ${e.done.slice(0, 150)}`);
		}
	}
	console.log(`\n总 function_call: ${acc.size}，含 done: ${withDone}，done 空串: ${emptyDone}`);
	console.log(`delta≠done 污染: ${mismatch}`);
});
