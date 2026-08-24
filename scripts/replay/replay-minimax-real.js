// 真实流取证:MiniMax-M3(chat completions + 原生 reasoning_content)
// 把真实 delta 序列灌进当前源码形态的解析器,看正文有没有被吞
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/glm53-effort-test.js", "utf8");
const KEY = src.match(/const KEY = "([^"]+)"/)[1];
const BASE = "https://newapi.libiaorobot.com/v1";
const LT = String.fromCharCode(60);

// ===== 解析器忠实复刻(commonApi 当前形态,含今天三处修复) =====
const T_OPEN = LT + "think>", T_CLOSE = LT + "/think>";
const TG_OPEN = LT + "thinking>", TG_CLOSE = LT + "/thinking>";
class Parser {
	constructor() {
		this._xmlThinkActive = false; this._xmlThinkEndTag = T_CLOSE; this._xmlThinkPending = "";
		this._hasEmittedAssistantText = false; this._currentThinkingId = null; this._everBufferedThinking = false;
		this.emittedText = []; this.thinkingBuffered = [];
	}
	reportEndThinking() { if (!this._currentThinkingId) return; this._currentThinkingId = null; }
	bufferThinkingContent(t) { this._everBufferedThinking = true; if (!this._currentThinkingId) this._currentThinkingId = "tid"; this.thinkingBuffered.push(t); }
	processTextContent(input) {
		if (!input || input.trim().length === 0) return { emittedAny: false };
		this.emittedText.push(input); this._hasEmittedAssistantText = true; return { emittedAny: true };
	}
	partialTagTail(s, tags) {
		for (const tag of tags) { const max = Math.min(tag.length - 1, s.length); for (let L = max; L >= 1; L--) if (s.endsWith(tag.slice(0, L))) return L; }
		return 0;
	}
	processXmlThinkBlocks(input) {
		if ((this._hasEmittedAssistantText || this._everBufferedThinking) && !this._xmlThinkActive) {
			if (this._xmlThinkPending) { const p = this._xmlThinkPending; this._xmlThinkPending = ""; this.processTextContent(p); }
			return { emittedAny: false };
		}
		const START_TAGS = [T_OPEN, TG_OPEN], END_TAGS = [T_CLOSE, TG_CLOSE];
		let data = this._xmlThinkPending + input; this._xmlThinkPending = "";
		let emittedAny = false;
		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				let startIdx = -1, tagLen = 0;
				for (let i = 0; i < START_TAGS.length; i++) {
					const idx = data.indexOf(START_TAGS[i]);
					if (idx !== -1 && (startIdx === -1 || idx < startIdx)) { startIdx = idx; tagLen = START_TAGS[i].length; this._xmlThinkEndTag = END_TAGS[i]; }
				}
				if (startIdx === -1) {
					const partial = this.partialTagTail(data, START_TAGS);
					const emitPart = data.slice(0, data.length - partial);
					this._xmlThinkPending = data.slice(data.length - partial);
					if (emitPart) { this.reportEndThinking(); this.processTextContent(emitPart); }
					emittedAny = true; data = ""; break;
				}
				if (startIdx > 0) { this.reportEndThinking(); this.processTextContent(data.slice(0, startIdx)); }
				emittedAny = true; this._xmlThinkActive = true; data = data.slice(startIdx + tagLen); continue;
			}
			const endIdx = data.indexOf(this._xmlThinkEndTag);
			if (endIdx === -1) {
				const partial = this.partialTagTail(data, [this._xmlThinkEndTag]);
				const bufferPart = data.slice(0, data.length - partial);
				this._xmlThinkPending = data.slice(data.length - partial);
				if (bufferPart) this.bufferThinkingContent(bufferPart);
				emittedAny = true; data = ""; break;
			}
			this.bufferThinkingContent(data.slice(0, endIdx));
			emittedAny = true; this._xmlThinkActive = false;
			data = data.slice(endIdx + this._xmlThinkEndTag.length);
		}
		return { emittedAny };
	}
}

(async () => {
	// 抓取真实流:让模型写含 < 比较符的代码(触发边界挂起)
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
		body: JSON.stringify({
			model: "MiniMax-M3",
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "写一个 TypeScript 函数判断数组是否有序,用泛型和小于号比较,最后附调用示例" }],
		}),
		signal: AbortSignal.timeout(120000),
	});
	console.log("HTTP", res.status);
	if (!res.ok) { console.log((await res.text()).slice(0, 300)); return; }

	const deltas = []; // {rc?, content?} 保留原始顺序
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
			const d = (p.choices || [])[0]?.delta;
			if (!d) continue;
			const rc = typeof d.reasoning_content === "string" ? d.reasoning_content : undefined;
			const content = typeof d.content === "string" ? d.content : undefined;
			if (rc || content) deltas.push({ rc, content });
		}
	}
	fs.writeFileSync(__dirname + "/minimax-m3-stream.json", JSON.stringify(deltas));
	console.log("delta 块数:", deltas.length, "→ minimax-m3-stream.json");

	// 灌进当前源码形态解析器(复刻 processDelta 的 content 分支)
	const parser = new Parser();
	let rawContent = "";
	for (const d of deltas) {
		if (d.rc) parser.bufferThinkingContent(d.rc);
		if (d.content !== undefined) {
			rawContent += d.content;
			const xmlRes = parser.processXmlThinkBlocks(d.content);
			if (!xmlRes.emittedAny) { parser.reportEndThinking(); parser.processTextContent(d.content); }
		}
	}
	const emitted = parser.emittedText.join("");
	console.log("\n=== 当前源码形态回放结果 ===");
	console.log("正文原始:", rawContent.length, "| 发射:", emitted.length, "| 思考缓冲:", parser.thinkingBuffered.join("").length, "| pending:", parser._xmlThinkPending.length);
	if (emitted.length < rawContent.length) console.log("!!! 正文被吞:", rawContent.length - emitted.length, "字符");
	else if (emitted.length > rawContent.length) console.log("!!! 发射超出原始量(重复)");
	else console.log("正文无损");
	console.log("正文是否含 < :", rawContent.includes(LT));
	console.log("正文尾部 80:", JSON.stringify(rawContent.slice(-80)));
})().catch(e => { console.error(e); process.exit(1); });
