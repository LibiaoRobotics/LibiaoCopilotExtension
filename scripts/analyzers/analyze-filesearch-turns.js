// 分析日志中 file_search_call 与响应中断的关联
// 用法: node scripts/analyze-filesearch-turns.js <logfile>
const fs = require("fs");
const readline = require("readline");

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

let cur = null; // 当前 response 的统计
const responses = [];

function newResp(id) {
	cur = { id, fs: 0, web: 0, textDelta: 0, textAfterFs: 0, fc: 0, fcAfterFs: 0, reasoningDelta: 0, status: null, startTs: null, endTs: null };
	responses.push(cur);
}

rl.on("line", (line) => {
	if (!line.includes("responses.stream.chunk") && !line.includes("responses.stream.done")) return;
	let obj;
	try { obj = JSON.parse(line); } catch { return; }
	const dataStr = obj.data?.data ?? (obj.data && typeof obj.data === "string" ? obj.data : null);
	if (!dataStr) return;
	let ev;
	try { ev = JSON.parse(dataStr); } catch { return; }
	const t = ev.type || "";
	// 任何携带 response.id 的事件：id 变化即视为新 response
	const respId = ev.response && typeof ev.response.id === "string" ? ev.response.id : null;
	if (respId && (!cur || cur.id !== respId)) newResp(respId);
	if (!cur) return;
	if (t === "response.output_item.added" && ev.item) {
		if (ev.item.type === "file_search_call") { cur.fs++; }
		if (ev.item.type === "web_search_call") { cur.web++; }
		if (ev.item.type === "function_call") { cur.fc++; if (cur.fs > 0) cur.fcAfterFs++; }
	}
	if (t === "response.output_text.delta" && ev.delta) { cur.textDelta++; if (cur.fs > 0) cur.textAfterFs++; }
	if (t === "response.reasoning_text.delta" && ev.delta) { cur.reasoningDelta++; }
	if (t === "response.completed" || t === "response.done") {
		const r = ev.response || ev;
		cur.status = r.status || cur.status;
		cur.endTs = obj.ts;
	}
	if (!cur.startTs) cur.startTs = obj.ts;
});

rl.on("close", () => {
	const withFs = responses.filter(r => r.fs > 0);
	console.log(`总 response 数: ${responses.length}`);
	console.log(`含 file_search_call 的 response: ${withFs.length}`);
	console.log(`含 web_search_call 的 response: ${responses.filter(r => r.web > 0).length}`);
	console.log("--- 含 file_search 的 response 明细 ---");
	for (const r of withFs) {
		console.log(`${r.id} | fs=${r.fs} | reasoning_delta=${r.reasoningDelta} | text_delta=${r.textDelta}(fs后=${r.textAfterFs}) | func_call=${r.fc}(fs后=${r.fcAfterFs}) | status=${r.status}`);
	}
	const noFsBroken = responses.filter(r => r.fs === 0 && r.textDelta === 0 && r.fc === 0);
	console.log(`--- 无 file_search 且零文本零工具调用的 response: ${noFsBroken.length} ---`);
	for (const r of noFsBroken.slice(0, 10)) {
		console.log(`${r.id} | reasoning_delta=${r.reasoningDelta} | status=${r.status}`);
	}
});
