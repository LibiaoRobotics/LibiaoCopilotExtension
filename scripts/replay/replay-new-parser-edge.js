// 定点打击:新解析器边界场景(标签用 charCode 动态构造,源码不含裸标签字面量,避免被工具链损坏)
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const T_OPEN = LT + "think" + GT;
const T_CLOSE = LT + "/think" + GT;
const TG_OPEN = LT + "thinking" + GT;
const TG_CLOSE = LT + "/thinking" + GT;

// ===== 新版解析器复刻(1:1 对应 src/commonApi.ts commit 6ff97bd) =====
class NewParser {
	constructor() {
		this._xmlThinkActive = false;
		this._xmlThinkEndTag = T_CLOSE;
		this._xmlThinkPending = "";
		this._hasEmittedAssistantText = false;
		this._currentThinkingId = null;
		this.emittedText = [];
		this.thinkingBuffered = [];
		this.endThinkingCount = 0;
	}
	reportEndThinking() {
		if (!this._currentThinkingId) return;
		this.endThinkingCount++;
		this._currentThinkingId = null;
	}
	bufferThinkingContent(text) {
		if (!this._currentThinkingId) this._currentThinkingId = "tid";
		this.thinkingBuffered.push(text);
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
		const START_TAGS = [T_OPEN, TG_OPEN];
		const END_TAGS = [T_CLOSE, TG_CLOSE];
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
			this.bufferThinkingContent(data.slice(0, endIdx));
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

function run(name, chunks) {
	const p = new NewParser();
	let raw = "";
	for (const c of chunks) { raw += c; p.processStreamedTextChunk(c); }
	p.reportEndThinking(); // 模拟 processStreamingResponse 的 finally
	const emitted = p.emittedText.join("");
	const swallowed = p.thinkingBuffered.join("");
	const pending = p._xmlThinkPending;
	console.log("\n=== " + name + " ===");
	console.log("原始:" + raw.length + " 发射:" + emitted.length + " 被吞进思考:" + swallowed.length + " 挂起:" + pending.length);
	if (swallowed.length > 0) console.log("!!! 正文字符被当作思考内容吞掉 " + swallowed.length + " 字符 → 聊天框里这段正文消失");
	if (pending.length > 0) console.log("!!! 流结束后挂起缓冲无人收尾,永久丢失: " + JSON.stringify(pending));
	if (swallowed.length === 0 && pending.length === 0) console.log("无损");
}

// 场景1:正文字面量含完整开标签但无闭合(讨论提示词工程/给出模板时极常见)
run("场景1: 正文字面量开标签无闭合", [
	"你可以用 " + T_OPEN + " 标签包裹思考。\n",
	"下面是代码示例,注意这里出现了完整的开始标签但没有闭合标签:",
]);

// 场景2:流以单个 "<" 结尾(下一块本来会接普通内容,但流在这里结束)
run("场景2: 流以 < 结尾", ["第一行正文", "第二行" + LT]);

// 场景3:流以 "<th" 结尾
run("场景3: 流以 <th 结尾", ["第一行正文", "第二行 " + LT + "th"]);

// 场景4:字面量开标签后模型继续输出大量正文(最贴近"消息被截断"的观感)
run("场景4: 字面量开标签后大量正文被吞", [
	"提示词模板如下: " + T_OPEN + " 这里写思考内容 " + T_CLOSE + "\n",
	"不对,上面是示例。真实场景里模型经常忘记闭合。",
	"然后是第二段正文。",
	"然后是第三段正文,这些都应该显示给用户,但会被解析器吞掉。",
]);

// 场景5:Anthropic 原生链路——thinking 走原生块,正文里出现字面量开标签后紧跟正常文本
run("场景5: 原生思考+正文字面量开标签", [
	"这是一个排序函数:" + T_OPEN, // 字面量开标签出现在正文
	"span class=\"x\">高亮文本" + GT + " 后面还有内容",
]);
