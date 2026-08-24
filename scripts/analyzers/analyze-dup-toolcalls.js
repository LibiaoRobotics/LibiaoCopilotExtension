// 统计日志中「同一 response 内出现同名同参数 function_call」的频率
// 判据：function_call_arguments.done 事件携带完整 arguments，按 response 分组比对
// 用法: node scripts/analyze-dup-toolcalls.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let curId = null;
const byResp = new Map(); // respId -> [{name, args, callId, outputIndex, msgId}]

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
	if (ev.type === "response.function_call_arguments.done") {
		const arr = byResp.get(curId) ?? [];
		arr.push({
			name: ev.name ?? "?",
			args: ev.arguments ?? "",
			callId: (ev.call_id ?? ev.item_id ?? "?"),
			outputIndex: ev.output_index,
			ts: obj.ts,
		});
		byResp.set(curId, arr);
	}
});

rl.on("close", () => {
	let dupResp = 0, totalCalls = 0;
	const dups = [];
	for (const [id, calls] of byResp) {
		totalCalls += calls.length;
		const seen = new Map();
		for (const c of calls) {
			const key = `${c.name}|${c.args}`;
			if (seen.has(key)) {
				dupResp++;
				dups.push({ id, name: c.name, args: c.args.slice(0, 120), callIds: [seen.get(key).callId, c.callId], idx: [seen.get(key).outputIndex, c.outputIndex], ts: c.ts });
			} else {
				seen.set(key, c);
			}
		}
	}
	console.log(`含 function_call done 的 response: ${byResp.size}，总调用数: ${totalCalls}`);
	console.log(`含重复（同名同参）调用的 response: ${dupResp}`);
	for (const d of dups) {
		console.log(`  ${d.ts} ${d.id} | ${d.name} | idx=${d.idx.join(",")} | callIds=${d.callIds.join(" vs ")} | args=${d.args}`);
	}
});
