// 验证修复:修复后逻辑(原生思考块出现后 text_delta 直接发射)回放
// 1) 真实捕获流:正文无损
// 2) 字面量开标签场景:不再吞正文
const fs = require("fs");
const path = require("path");
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const T_OPEN = LT + "think" + GT;
const T_CLOSE = LT + "/think" + GT;
const TG_OPEN = LT + "thinking" + GT;
const TG_CLOSE = LT + "/thinking" + GT;

// ===== 修复后的 anthropic 链路复刻 =====
class FixedAnthropicHandler {
	constructor() {
		this._sawNativeThinkingBlock = false; // 新增标志
		this._xmlThinkActive = false;
		this._xmlThinkEndTag = T_CLOSE;
		this._xmlThinkPending = "";
		this._hasEmittedAssistantText = false;
		this._currentThinkingId = null;
		this.emittedText = [];
		this.thinkingBuffered = [];
	}
	reportEndThinking() { if (!this._currentThinkingId) return; this._currentThinkingId = null; }
	bufferThinkingContent(text) { if (!this._currentThinkingId) this._currentThinkingId = "tid"; this.thinkingBuffered.push(text); }
	processTextContent(input) {
		if (!input || input.trim().length === 0) return;
		this.emittedText.push(input);
		this._hasEmittedAssistantText = true;
	}
	partialTagTail(s, tags) {
		for (const tag of tags) {
			const max = Math.min(tag.length - 1, s.length);
			for (let L = max; L >= 1; L--) if (s.endsWith(tag.slice(0, L))) return L;
		}
		return 0;
	}
	processXmlThinkBlocks(input) {
		if (this._hasEmittedAssistantText && !this._xmlThinkActive) return { emittedAny: false };
		const START_TAGS = [T_OPEN, TG_OPEN], END_TAGS = [T_CLOSE, TG_CLOSE];
		let data = this._xmlThinkPending + input;
		this._xmlThinkPending = "";
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
				emittedAny = true; this._xmlThinkActive = true;
				data = data.slice(startIdx + tagLen); continue;
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
	processStreamedTextChunk(text) {
		if (!text) return;
		const xmlRes = this.processXmlThinkBlocks(text);
		if (!xmlRes.emittedAny) { this.reportEndThinking(); this.processTextContent(text); }
	}
	// ===== 修复核心:processAnthropicChunk 的分流逻辑 =====
	onNativeThinkingStart() { this._sawNativeThinkingBlock = true; }
	onThinkingDelta(text) { this._sawNativeThinkingBlock = true; this.bufferThinkingContent(text); }
	onTextDelta(text) {
		if (this._sawNativeThinkingBlock) {
			this.reportEndThinking();
			this.processTextContent(text); // 原生链路:直接发射
		} else {
			this.processStreamedTextChunk(text); // 翻译层:保留 XML 解析
		}
	}
}

// ---- 验证1:真实捕获流 ----
const eventsPath = path.join(__dirname, "glm52-stream-events.json");
const events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
const h = new FixedAnthropicHandler();
let rawText = "";
for (const ev of events) {
	if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") h.onNativeThinkingStart();
	if (ev.type === "content_block_delta") {
		if (ev.delta?.type === "text_delta" && ev.delta.text) { rawText += ev.delta.text; h.onTextDelta(ev.delta.text); }
		else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) h.onThinkingDelta(ev.delta.thinking);
	} else if (ev.type === "content_block_stop" || ev.type === "message_stop") h.reportEndThinking();
}
h.reportEndThinking();
const emitted = h.emittedText.join("");
console.log("=== 验证1:真实捕获流(修复后) ===");
console.log("原始 text_delta:", rawText.length, "| 发射:", emitted.length, "| pending:", h._xmlThinkPending.length);
console.log(rawText.length === emitted.length ? "✅ 正文无损" : "❌ 仍有差异:" + (rawText.length - emitted.length));

// ---- 验证2:字面量开标签场景(原场景5,截断元凶) ----
const h2 = new FixedAnthropicHandler();
const chunks2 = ["这是一个排序函数:" + T_OPEN, "span高亮文本" + GT + " 后面还有内容"];
let raw2 = "";
// 模拟:先收到原生思考块(置标志),再收到含字面量开标签的正文
h2.onNativeThinkingStart();
h2.onThinkingDelta("思考内容");
for (const c of chunks2) { raw2 += c; h2.onTextDelta(c); }
h2.reportEndThinking();
console.log("\n=== 验证2:原生思考+字面量开标签(原截断场景) ===");
console.log("原始:", raw2.length, "| 发射:", h2.emittedText.join("").length, "| 吞掉:", h2.thinkingBuffered.join("").length - "思考内容".length);
console.log(raw2.length === h2.emittedText.join("").length ? "✅ 不再截断" : "❌ 仍被吞");

// ---- 验证3:翻译层网关(无原生思考块,思考内联进 text)仍走 XML 解析 ----
const h3 = new FixedAnthropicHandler();
h3.onTextDelta(T_OPEN + "内联思考内容" + T_CLOSE + "这是正文");
h3.reportEndThinking();
console.log("\n=== 验证3:翻译层网关(无原生思考块) ===");
console.log("发射正文:", JSON.stringify(h3.emittedText.join("")), "| 思考缓冲:", JSON.stringify(h3.thinkingBuffered.join("")));
console.log(h3.thinkingBuffered.join("") === "内联思考内容" && h3.emittedText.join("") === "这是正文" ? "✅ 思考/正文分流正确" : "❌ 分流异常");
