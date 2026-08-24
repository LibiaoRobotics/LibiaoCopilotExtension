// TPS 测试功能实弹验证（glm-5.2 anthropic 链路）
// 完全复刻 modelTester.ts 的 testSingleModel + buildTestRequestBody 参数
const BASE = process.env.LIBIAO_BASE_URL || "https://newapi.libiaorobot.com/v1";
const KEY = process.env.LIBIAO_API_KEY || "sk-wI5qUOGVWL3sWGvcE3qM40f3BzLHM9kOimo2QXnobRJ9lzZ6";

// buildTestRequestBody(anthropic) 的输出：max_tokens=4096, thinking budget 压到 1024
const body = {
	model: "glm-5.2",
	messages: [{ role: "user", content: "这是一次tps吞吐量测试，直接输出300Token左右的代码" }],
	stream: true,
	max_tokens: 4096,
	thinking: { type: "enabled", budget_tokens: 1024 },
};

const requestStart = Date.now();
let firstEventAt = null;
let outputChars = 0;
let usage = null;
const eventTypes = new Map();
const thinkingChars = { n: 0 };
let textChars = 0;

const res = await fetch(`${BASE}/messages`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		"User-Agent": "libiao-copilot/tps-probe",
		"x-api-key": KEY,
		"anthropic-version": "2023-06-01",
	},
	body: JSON.stringify(body),
});
console.log("HTTP", res.status, res.statusText);
if (!res.ok) {
	console.log(await res.text());
	process.exit(1);
}

// ---- 复刻 consumeStream：逐行 SSE，extractUsage + extractDeltaChars ----
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	if (firstEventAt === null) firstEventAt = Date.now();
	buffer += decoder.decode(value, { stream: true });
	const lines = buffer.split("\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
		if (!payload || payload === "[DONE]") continue;
		let parsed;
		try { parsed = JSON.parse(payload); } catch { continue; }
		eventTypes.set(parsed.type, (eventTypes.get(parsed.type) ?? 0) + 1);
		// extractUsage: message_delta 分支（modelTester 只认 message_delta，不认 message_start）
		if (parsed.type === "message_delta" && parsed.usage && typeof parsed.usage === "object") {
			const u = parsed.usage;
			const completion = Number(u.output_tokens) || 0;
			const prompt = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
			if (completion > 0 || prompt > 0) usage = { prompt_tokens: prompt, completion_tokens: completion };
		}
		// extractDeltaChars: content_block_delta.delta.text
		if (parsed.type === "content_block_delta" && parsed.delta && typeof parsed.delta.text === "string") {
			outputChars += parsed.delta.text.length;
			textChars += parsed.delta.text.length;
		}
		if (parsed.type === "content_block_delta" && parsed.delta && typeof parsed.delta.thinking === "string") {
			thinkingChars.n += parsed.delta.thinking.length;
		}
		// 记录 message_start 的 usage（探针补充观察）
		if (parsed.type === "message_start" && parsed.message?.usage) {
			console.log("message_start.usage:", JSON.stringify(parsed.message.usage));
		}
		if (parsed.type === "message_delta" && parsed.usage) {
			console.log("message_delta.usage:", JSON.stringify(parsed.usage));
		}
	}
}
const totalMs = Date.now() - requestStart;
const ttftMs = firstEventAt ? firstEventAt - requestStart : null;
const generateMs = Math.max(1, totalMs - ttftMs);
const outTokens = usage?.completion_tokens ?? Math.max(1, Math.round(outputChars * 0.6));
console.log("\n===== 结果 =====");
console.log("事件类型分布:", JSON.stringify(Object.fromEntries(eventTypes)));
console.log("TTFT:", ttftMs, "ms | 总耗时:", totalMs, "ms | generateMs:", generateMs, "ms");
console.log("usage:", JSON.stringify(usage));
console.log("正文 text delta 字符:", textChars, "| 思考 delta 字符:", thinkingChars.n);
console.log("outputChars(估算用):", outputChars, "→ 估算 tokens:", Math.max(1, Math.round(outputChars * 0.6)));
console.log("TPS(usage 优先):", (outTokens / generateMs * 1000).toFixed(1));
console.log("判定:", usage?.completion_tokens > 0 || outputChars > 0 ? "成功" : "失败(0 token)");
