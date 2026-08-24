// TPS 测试功能实弹验证（qwen3.8-max openai-responses 链路）
// 复刻 modelTester.ts buildTestRequestBody(openai-responses) + prepareRequestBody 最终产物
const BASE = "https://newapi.libiaorobot.com/v1";
const KEY = "sk-wI5qUOGVWL3sWGvcE3qM40f3BzLHM9kOimo2QXnobRJ9lzZ6";

const body = {
	model: "qwen3.8-max",
	reasoning_effort: "low",
	reasoning: { effort: "low" },
	max_output_tokens: 4096,
	input: [
		{
			role: "user",
			content: [{ type: "input_text", text: "这是一次tps吞吐量测试，直接输出300Token左右的代码" }],
			type: "message",
			id: `msg_test_${Date.now()}`,
			status: "completed",
		},
	],
	stream: true,
};

const requestStart = Date.now();
let firstEventAt = null;
let outputChars = 0;
let usage = null;
const eventTypes = new Map();
let reasoningChars = 0;
let textChars = 0;

const res = await fetch(`${BASE}/responses`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		"User-Agent": "libiao-copilot/tps-probe",
		Authorization: `Bearer ${KEY}`,
	},
	body: JSON.stringify(body),
});
console.log("HTTP", res.status, res.statusText);
if (!res.ok) {
	console.log(await res.text());
	process.exit(1);
}

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
		// extractUsage: response.completed 分支
		if (parsed.type === "response.completed") {
			const u = parsed.response?.usage ?? parsed.usage;
			if (u) {
				const completion = Number(u.output_tokens ?? u.completion_tokens) || 0;
				const prompt = Number(u.input_tokens ?? u.prompt_tokens) || 0;
				if (completion > 0 || prompt > 0) usage = { prompt_tokens: prompt, completion_tokens: completion };
			}
		}
		// extractDeltaChars: response.output_text.delta
		if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
			outputChars += parsed.delta.length;
			textChars += parsed.delta.length;
		}
		if (parsed.type === "response.reasoning_text.delta" && typeof parsed.delta === "string") {
			reasoningChars += parsed.delta.length;
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
console.log("正文 text delta 字符:", textChars, "| 思考 reasoning delta 字符:", reasoningChars);
console.log("TPS(usage 优先):", (outTokens / generateMs * 1000).toFixed(1));
console.log("判定:", usage?.completion_tokens > 0 || outputChars > 0 ? "成功" : "失败(0 token)");
