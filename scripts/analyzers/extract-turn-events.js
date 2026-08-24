// 提取指定行范围内 responses 流事件的类型与内容摘要
// 用法: node scripts/extract-turn-events.js <logfile> <startLine> <endLine>
const fs = require("fs");
const file = process.argv[2];
const start = parseInt(process.argv[3], 10) - 1;
const end = parseInt(process.argv[4], 10);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(start, end);

for (const line of lines) {
	if (!line.includes("responses.stream.chunk")) continue;
	let obj;
	try { obj = JSON.parse(line); } catch { continue; }
	const dataStr = obj.data && obj.data.data;
	if (!dataStr) continue;
	let ev;
	try { ev = JSON.parse(dataStr); } catch { continue; }
	const t = ev.type || "?";
	let snippet = "";
	if (typeof ev.delta === "string") snippet = ev.delta;
	else if (typeof ev.text === "string") snippet = ev.text;
	else if (ev.item && typeof ev.item.type === "string") snippet = `[item:${ev.item.type}]`;
	snippet = snippet.replace(/\s+/g, " ").slice(0, 90);
	console.log(`${obj.ts.slice(11, 19)} seq=${String(ev.sequence_number ?? "-").padStart(4)} idx=${ev.output_index ?? "-"} ${t} ${snippet}`);
}
