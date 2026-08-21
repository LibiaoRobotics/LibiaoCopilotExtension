/**
 * 批量给内置模型表写入 priceNote（语言模型管理界面成本列的自定义文字）。
 *
 * 注意（特哥血泪教训）：
 * 1. emoji 一律用 JSON 转义序列写入（\uXXXX），不写字面 emoji —— 编辑工具写字面 emoji 会损坏成 U+FFFD；
 * 2. 用文本级正则替换，不做 JSON.parse + JSON.stringify 整体重写 —— 会破坏 package.json 的 tab 缩进格式；
 * 3. 写入后用 JSON.parse 验证合法性 + 码点数组验证 emoji 完整性。
 *
 * 用法：node scripts/set-price-notes.js  （在 libiao-copilot/ 目录下运行）
 *
 * 注意：本文件内禁止出现字面 emoji/符号字符（编辑工具会损坏），
 * 校验输出用的勾/叉符号用码点构造。
 */
const fs = require("fs");
const path = require("path");

const PKG = path.join(__dirname, "..", "package.json");

// emoji 用 JSON 转义序列写进 package.json: star = \u2B50\uFE0F, cross = \u274C\uFE0F
// 注意：以下字符串是「字面反斜杠 + uXXXX」形态（将来 package.json 里 JSON.parse 才还原 emoji），
// 汉字部分不用转义，直接用明文（写入文件正文）。
const REC_TEXT =
	'"' +
	"\\u2B50\\uFE0F" +
	"推荐" +
	"\\u2B50\\uFE0F" +
	'"';
const NOT_REC_TEXT =
	'"' +
	"\\u274C\\uFE0F" +
	"不推荐" +
	"\\u274C\\uFE0F" +
	'"';

// id -> 要写入的 priceNote JSON 文本
const assigns = {
	// 推荐（4 个）
	"qwen3.8-max": REC_TEXT,
	"deepseek-v4-flash": REC_TEXT,
	"deepseek-v4-flash-vision-exp": REC_TEXT,
	"glm-5.3": REC_TEXT,
	// 不推荐（11 个）
	"deepseek-v4-pro": NOT_REC_TEXT,
	"gemini-3.1-flash-image": NOT_REC_TEXT,
	"gemini-3.5-flash": NOT_REC_TEXT,
	"gpt-5.6-luna": NOT_REC_TEXT,
	"gpt-5.6-terra": NOT_REC_TEXT,
	"gpt-5.5": NOT_REC_TEXT,
	"claude-opus-4-8": NOT_REC_TEXT,
	"MiniMax-M3": NOT_REC_TEXT,
	"glm-5.2": NOT_REC_TEXT,
	"qwen3.7-plus": NOT_REC_TEXT,
	"qwen3.7-max": NOT_REC_TEXT,
};

// 期望的码点序列（用于校验 emoji 完整性）
const REC_POINTS = [0x2b50, 0xfe0f, 0x63a8, 0x8350, 0x2b50, 0xfe0f]; // star推荐star
const NOT_POINTS = [0x274c, 0xfe0f, 0x4e0d, 0x63a8, 0x8350, 0x274c, 0xfe0f]; // cross不推荐cross

// 输出用的勾/叉符号（码点构造，避免字面符号损坏）
const OK_MARK = String.fromCodePoint(0x2713);
const BAD_MARK = String.fromCodePoint(0x2717);

let text = fs.readFileSync(PKG, "utf8");
const before = text;

// 按行处理（兼容 CRLF/LF）：找到 id 行的下一行，在其后插入 priceNote
const lines = text.split(/\r?\n/);
const eol = text.includes("\r\n") ? "\r\n" : "\n";

let total = 0;
for (const [id, noteJson] of Object.entries(assigns)) {
	const idIdx = lines.findIndex((l) => l.includes('"id": "' + id + '"'));
	if (idIdx < 0) {
		console.error(BAD_MARK + " 未找到模型条目: " + id);
		process.exit(1);
	}
	const dnLine = lines[idIdx + 1]; // displayName 所在行
	const indentMatch = dnLine.match(/^[\t ]*/);
	const indent = indentMatch ? indentMatch[0] : "\t\t\t";
	lines.splice(idIdx + 1, 0, indent + '"priceNote": ' + noteJson + ",");
	total++;
}

text = lines.join(eol);

// 防御：改前文件不应已存在 priceNote（脚本非幂等）
const changedCount = (before.match(/"priceNote"/g) ?? []).length;
if (changedCount !== 0) {
	console.error(BAD_MARK + " 改前文件已存在 priceNote，脚本不是幂等的，请人工检查！");
	process.exit(1);
}

fs.writeFileSync(PKG, text, "utf8");
console.log(OK_MARK + " 已写入 " + total + " 个模型的 priceNote");

// ===== 验证 =====
const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
const models = pkg.contributes.configuration.properties["libiaoCopilot.models"].default;
console.log("\n验证（共 " + models.length + " 个内置模型）：");

let failed = 0;
for (const m of models) {
	const note = m.priceNote;
	if (!note) {
		console.log("  - " + m.id.padEnd(32) + " （无）");
		continue;
	}
	const points = [...note].map((c) => c.codePointAt(0));
	// 判定用「不」字（U+4E0D）：不推荐 = 含不字；推荐 = 不含不字
	const expected = note.includes("\u4E0D") ? NOT_POINTS : REC_POINTS;
	const ok = JSON.stringify(points) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(
		"  " + (ok ? OK_MARK : BAD_MARK) + " " + m.id.padEnd(32) + " " +
		points.map((p) => "U+" + p.toString(16).toUpperCase()).join(" ")
	);
}

if (failed > 0) {
	console.error("\n" + BAD_MARK + " " + failed + " 个模型的码点校验失败！");
	process.exit(1);
}
const recCount = models.filter((m) => m.priceNote && !m.priceNote.includes("\u4E0D")).length;
const notRecCount = models.filter((m) => m.priceNote && m.priceNote.includes("\u4E0D")).length;
const noneCount = models.filter((m) => !m.priceNote).length;
console.log("\n" + OK_MARK + " 码点校验全部通过（推荐 " + recCount + " / 不推荐 " + notRecCount + " / 无 " + noneCount + "）");