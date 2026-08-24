// GLM-5.3 思考等级实测脚本
// 网关: https://newapi.libiaorobot.com/v1
// 目标: 验证 OpenAI 协议 reasoning_effort 与 Anthropic 协议 effort 通道是否生效
// 判定方式: 对比不同档位下 reasoning_content 长度 + completion_tokens 用量

const BASE = "https://newapi.libiaorobot.com/v1";
const KEY = "sk-wI5qUOGVWL3sWGvcE3qM40f3BzLHM9kOimo2QXnobRJ9lzZ6";
const MODEL = "glm-5.3";
const PROMPT = "用一句话说明斐波那契数列的定义，然后给出第 30 项的值。";

async function callOpenAI(body) {
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${KEY}`,
		},
		body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: PROMPT }], ...body }),
	});
	const text = await res.text();
	return { status: res.status, text };
}

async function callAnthropic(body) {
	const res = await fetch(`${BASE}/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": KEY,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({ model: MODEL, max_tokens: 8192, messages: [{ role: "user", content: PROMPT }], ...body }),
	});
	const text = await res.text();
	return { status: res.status, text };
}

function summarize(label, result) {
	console.log(`\n===== ${label} =====`);
	console.log(`HTTP ${result.status}`);
	if (result.status !== 200) {
		console.log(`响应: ${result.text.slice(0, 500)}`);
		return;
	}
	let j;
	try {
		j = JSON.parse(result.text);
	} catch (e) {
		console.log(`解析失败: ${result.text.slice(0, 500)}`);
		return;
	}
	const choice = j.choices?.[0] ?? j.content?.[0];
	const reasoning = j.choices?.[0]?.message?.reasoning_content ?? "";
	// OpenAI 协议
	if (j.choices) {
		console.log(`content len: ${(j.choices[0].message.content ?? "").length}`);
		console.log(`reasoning len: ${reasoning.length}`);
		console.log(`usage: ${JSON.stringify(j.usage)}`);
		console.log(`reasoning 预览: ${reasoning.slice(0, 120)}`);
	} else {
		// Anthropic 协议
		const blocks = j.content ?? [];
		let text = "";
		let think = "";
		for (const b of blocks) {
			if (b.type === "text") text += b.text;
			if (b.type === "thinking") think += b.thinking;
		}
		console.log(`content len: ${text.length}`);
		console.log(`thinking len: ${think.length}`);
		console.log(`usage: ${JSON.stringify(j.usage)}`);
		console.log(`thinking 预览: ${think.slice(0, 120)}`);
	}
}

async function main() {
	// === OpenAI 协议: 验证 reasoning_effort 三档 ===
	console.log("########## OpenAI 协议 (chat/completions) ##########");
	for (const effort of ["low", "high", "max"]) {
		const r = await callOpenAI({ thinking: { type: "enabled" }, reasoning_effort: effort, max_tokens: 2048 });
		summarize(`OpenAI + thinking.enabled + reasoning_effort=${effort}`, r);
	}

	// === Anthropic 协议: 现状（扩展当前传法 thinking + budget_tokens） ===
	console.log("\n\n########## Anthropic 协议 (messages) ##########");
	const rA = await callAnthropic({ thinking: { type: "enabled", budget_tokens: 32000 } });
	summarize("Anthropic + thinking(budget_tokens=32000) [现状扩展传法]", rA);

	// === Anthropic 协议: 顶层 reasoning_effort ===
	const rB = await callAnthropic({ thinking: { type: "enabled", budget_tokens: 32000 }, reasoning_effort: "high" });
	summarize("Anthropic + reasoning_effort=high(顶层)", rB);

	// === Anthropic 协议: output_config.effort（Claude Code 传法） ===
	const rC = await callAnthropic({ thinking: { type: "enabled", budget_tokens: 32000 }, output_config: { effort: "high" } });
	summarize("Anthropic + output_config.effort=high", rC);

	// === Anthropic 协议: 无 thinking 参数（纯默认） ===
	const rD = await callAnthropic({});
	summarize("Anthropic + 无 thinking 参数", rD);
}

main().catch((e) => {
	console.error("脚本异常:", e);
	process.exit(1);
});
