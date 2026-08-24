// 回放：把网关真实事件流灌进「今天新版解析器」的忠实复刻，逐字比对是否吞字/截断
// 解析器逻辑 1:1 复刻自 src/commonApi.ts（commit 6ff97bd 之后）
const fs = require("fs");
const events = JSON.parse(fs.readFileSync(__dirname + "/glm52-stream-events.json", "utf8"));

// ===== 新版解析器复刻 =====
class NewParser {
	constructor() {
		this._xmlThinkActive = false;
		this._xmlThinkEndTag = "</think>";
		this._xmlThinkPending = "";
		this._hasEmittedAssistantText = false;
		this._currentThinkingId = null;
		this.emittedText = [];
		this.thinkingText = [];
		this.endThinkingCount = 0;
	}
	reportEndThinking() {
		if (!this._currentThinkingId) return;
		this.endThinkingCount++;
		this._currentThinkingId = null;
	}
	bufferThinkingContent(text) {
		if (!this._currentThinkingId) this._currentThinkingId = "tid";
		this.thinkingText.push(text);
	}
	processTextContent(input) {
		if (!input || input.trim().length === 0) return { emittedAny: false };
		this.emittedText.push(input);
		this._hasEmittedAssistantText = true;
		return { emittedAny: true };
	}
	partialTagTail(s, tags) {
		for (const tag of tags) {
			const max = Math.min(tag.length - 1, s.length);
			for (let L = max; L >= 1; L--) {
				if (s.endsWith(tag.slice(0, L))) return L;
			}
		}
		return 0;
	}
	processXmlThinkBlocks(input) {
		if (this._hasEmittedAssistantText && !this._xmlThinkActive) {
			return { emittedAny: false };
		}
		const START_TAGS = ["<think>", "<thinking>"];
		const END_TAGS = ["</think>", "</thinking>"];
		let data = this._xmlThinkPending + input;
		this._xmlThinkPending = "";
		let emittedAny = false;
		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				let startIdx = -1, tagLen = 0;
				for (let i = 0; i < START_TAGS.length; i++) {
					const idx = data.indexOf(START_TAGS[i]);
					if (idx !== -1 && (startIdx === -1 || idx < startIdx)) {
						startIdx = idx; tagLen = START_TAGS[i].length;
						this._xmlThinkEndTag = END_TAGS[i];
					}
				}
				if (startIdx === -1) {
					const partial = this.partialTagTail(data, START_TAGS);
					const emitPart = data.slice(0, data.length - partial);
					this._xmlThinkPending = data.slice(data.length - partial);
					if (emitPart) { this.reportEndThinking(); this.processTextContent(emitPart); }
					emittedAny = true; data = ""; break;
				}
				if (startIdx > 0) { this.reportEndThinking(); this.processTextContent(data.slice(0, startIdx)); }
				emittedAny = true;
				this._xmlThinkActive = true;
				data = data.slice(startIdx + tagLen);
				continue;
			}
			const endIdx = data.indexOf(this._xmlThinkEndTag);
			if (endIdx === -1) {
				const partial = this.partialTagTail(data, [this._xmlThinkEndTag]);
				const bufferPart = data.slice(0, data.length - partial);
				this._xmlThinkPending = data.slice(data.length - partial);
				if (bufferPart) this.bufferThinkingContent(bufferPart);
				emittedAny = true; data = ""; break;
			}
			const thinkContent = data.slice(0, endIdx);
			this.bufferThinkingContent(thinkContent);
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + this._xmlThinkEndTag.length);
		}
		return { emittedAny };
	}
	processStreamedTextChunk(text) {
		if (!text) return;
		const xmlRes = this.processXmlThinkBlocks(text);
		if (!xmlRes.emittedAny) {
			this.reportEndThinking();
			this.processTextContent(text);
		}
	}
}

// ===== 回放 =====
const parser = new NewParser();
const rawTextDeltas = [];
for (const ev of events) {
	if (ev.type === "content_block_delta") {
		if (ev.delta?.type === "text_delta" && ev.delta.text) {
			rawTextDeltas.push(ev.delta.text);
			parser.processStreamedTextChunk(ev.delta.text);   // 新链路：anthropicApi 的调用方式
		} else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
			parser.bufferThinkingContent(ev.delta.thinking);
		}
	} else if (ev.type === "content_block_stop" || ev.type === "message_stop") {
		parser.reportEndThinking();
	}
}

// 收尾：模拟 processStreamingResponse 的 finally（reportEndThinking）
parser.reportEndThinking();

const rawText = rawTextDeltas.join("");
const emitted = parser.emittedText.join("");
const thinkingEmitted = parser.thinkingText.join("");

console.log("=== 回放结果（新版解析器） ===");
console.log("原始 text_delta 总字符:", rawText.length);
console.log("发射为正文的字符:", emitted.length, "| pending 挂起未发射:", parser._xmlThinkPending.length);
console.log("思考缓冲字符:", thinkingEmitted.length);
console.log("endThinking 次数:", parser.endThinkingCount);
if (parser._xmlThinkPending) {
	console.log("!!! 流结束时仍有挂起缓冲:", JSON.stringify(parser._xmlThinkPending.slice(0, 80)));
}

// 丢失检测：原始正文去掉 think 标签后的内容是否都发射了
// 这里先看最直接的：发射量 < 原始量 → 有字被吞
if (emitted.length + parser._xmlThinkPending.length < rawText.length) {
	const lost = rawText.length - emitted.length - parser._xmlThinkPending.length;
	console.log(`!!! 正文丢失约 ${lost} 字符（被当作 think 内容缓冲或标签吞掉）`);
	// 定位丢失：找第一段发射缺失
	console.log("原始正文尾部 120:", JSON.stringify(rawText.slice(-120)));
	console.log("发射正文尾部 120:", JSON.stringify(emitted.slice(-120)));
} else if (emitted.length > rawText.length) {
	console.log("!!! 发射量超过原始量（重复发射）");
}

// 旧版解析器对比：旧逻辑直接发射（anthropic 原生链路根本不该走 XML 解析）
console.log("\n=== 对比：旧版行为（直接发射，无 XML 解析） ===");
console.log("旧版发射:", rawText.length, "字符（全量无损）");
