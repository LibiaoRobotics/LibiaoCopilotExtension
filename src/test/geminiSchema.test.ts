import * as assert from "assert";
import { stripUnsupportedGeminiSchemaKeys } from "../gemini/geminiApi";

// 回归测试（2026-08-23 gemini-3.7-flash 事故）：
// VS Code/MCP 工具的 inputSchema 带 JSON Schema 关键字 propertyNames，
// 原样透传给 Gemini API → protojson 严格解析报
// `Unknown name "propertyNames" at "tools[0].function_declarations[N].properties[x].value"` → HTTP 400。
	// 修复：严格白名单过滤，发送前剥离所有非 Gemini 支持的关键字。
	suite("gemini schema key stripping", () => {
	test("剥离 propertyNames 与 patternProperties，保留白名单内 min/maxProperties", () => {
		const schema = {
			type: "object",
			properties: {
				item: {
					type: "object",
					propertyNames: { pattern: "^[a-z]+$" },
					patternProperties: { "^x-": { type: "string" } },
					properties: { name: { type: "string" } },
				},
			},
			minProperties: 1,
			maxProperties: 10,
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.strictEqual(removed, 2, `应剥离 propertyNames+patternProperties 恰好 2 个，实际 ${removed}`);
		assert.strictEqual(schema.properties.item.propertyNames, undefined, "propertyNames 应被剥离");
		assert.strictEqual(schema.properties.item.patternProperties, undefined, "patternProperties 应被剥离");
		assert.strictEqual(schema.minProperties, 1, "minProperties 在白名单内，应保留");
		assert.strictEqual(schema.maxProperties, 10, "maxProperties 在白名单内，应保留");
		assert.deepStrictEqual(schema.properties.item.properties, { name: { type: "string" } }, "合法字段 properties 应保留");
	});

	test("回归：properties 中的用户属性名绝不能被剥离（2026-08-23 400 事故）", () => {
		// 事故根因：stripUnsupportedGeminiSchemaKeys 递归时把 properties 的属性名
		// （dirPath/filePath 等）当成 schema 关键字按白名单删除，导致
		// properties:{} + required:["dirPath"] → Gemini protojson 报
		// `required[0]: property is not defined` → HTTP 400。
		const schema = {
			type: "object",
			properties: {
				dirPath: { type: "string", description: "The absolute path to the directory to create." },
				filePath: { type: "string" },
				content: { type: "string", description: "内容" },
			},
			required: ["dirPath", "filePath", "content"],
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.strictEqual(removed, 0, `合法属性名不应被剥离，实际剥离 ${removed} 个`);
		assert.deepStrictEqual(
			Object.keys(schema.properties),
			["dirPath", "filePath", "content"],
			"属性名全部保留"
		);
		assert.strictEqual(schema.properties.dirPath.type, "string", "dirPath.type 保留");
		assert.strictEqual(schema.properties.dirPath.description, "The absolute path to the directory to create.", "description 保留");
		assert.deepStrictEqual(schema.required, ["dirPath", "filePath", "content"], "required 保留");
		// 关键一致性校验：required 中每个属性必须存在于 properties
		for (const r of schema.required) {
			assert.ok(r in schema.properties, `required 属性 ${r} 必须在 properties 中存在`);
		}
	});

	test("回归：属性名与关键字重名（description/type）不可误删", () => {
		const schema = {
			type: "object",
			properties: {
				description: { type: "string" },
				type: { type: "string" },
			},
			required: ["description", "type"],
		};

		stripUnsupportedGeminiSchemaKeys(schema);
		assert.deepStrictEqual(Object.keys(schema.properties), ["description", "type"], "重名属性保留");
		assert.strictEqual(schema.properties.description.type, "string");
		assert.strictEqual(schema.properties.type.type, "string");
	});

	test("保留 Gemini Schema 支持的合法字段", () => {
		const schema = {
			type: "object",
			description: "工具描述",
			properties: {
				name: { type: "string", description: "名称", minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
				count: { type: "integer", minimum: 0, maximum: 10 },
				tags: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5, uniqueItems: true },
			},
			required: ["name"],
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.strictEqual(removed, 1, `仅 uniqueItems（不在白名单）应被剥离，实际剥离 ${removed} 个`);
		assert.strictEqual(schema.description, "工具描述", "description 应保留");
		assert.strictEqual(schema.properties.name.minLength, 1, "minLength 应保留");
		assert.strictEqual(schema.properties.name.pattern, "^[a-z]+$", "pattern 应保留");
		assert.strictEqual(schema.properties.tags.uniqueItems, undefined, "uniqueItems 不在 Gemini 白名单，应被剥离");
		assert.deepStrictEqual(schema.required, ["name"], "required 应保留");
	});

	test("剥离 if/then/else/not 条件关键字", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: "string",
					if: { properties: { kind: { const: "a" } } },
					then: { minLength: 1 },
					else: { minLength: 5 },
					not: { enum: ["bad"] },
				},
			},
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.ok(removed >= 4, `应剥离 4 个条件关键字，实际 ${removed}`);
		assert.strictEqual(schema.properties.value.if, undefined, "if 应被剥离");
		assert.strictEqual(schema.properties.value.then, undefined, "then 应被剥离");
		assert.strictEqual(schema.properties.value.else, undefined, "else 应被剥离");
		assert.strictEqual(schema.properties.value.not, undefined, "not 应被剥离");
	});

	test("递归剥离嵌套数组中的未知 key", () => {
		const schema = {
			type: "array",
			items: {
				type: "object",
				properties: {
					x: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 100 },
				},
				propertyNames: { pattern: "^[a-z]+$" },
			},
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.ok(removed >= 3, `应剥离 3 个未知 key，实际 ${removed}`);
		assert.strictEqual(schema.items.propertyNames, undefined, "嵌套 propertyNames 应被剥离");
		assert.strictEqual(schema.items.properties.x.exclusiveMinimum, undefined, "嵌套 exclusiveMinimum 应被剥离");
		assert.strictEqual(schema.items.properties.x.exclusiveMaximum, undefined, "嵌套 exclusiveMaximum 应被剥离");
	});

	test("严格白名单：对未来任何未知的 Draft/自定义关键字一律免疫过滤", () => {
		const schema = {
			type: "object",
			properties: {
				code: {
					type: "string",
					description: "代码内容",
					prefixItems: ["future1"],
					unevaluatedProperties: false,
					contentMediaType: "text/plain",
					$anchor: "anchorRef",
					customFutureField: 12345,
				},
			},
			additionalProperties: false,
			customTopLevelField: true,
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.ok(removed >= 7, `应剥离所有非白名单关键字，实际剥离 ${removed}`);
		assert.strictEqual((schema as Record<string, unknown>).customTopLevelField, undefined);
		assert.strictEqual((schema as Record<string, unknown>).additionalProperties, undefined);
		assert.strictEqual((schema.properties.code as Record<string, unknown>).prefixItems, undefined);
		assert.strictEqual((schema.properties.code as Record<string, unknown>).unevaluatedProperties, undefined);
		assert.strictEqual((schema.properties.code as Record<string, unknown>).contentMediaType, undefined);
		assert.strictEqual((schema.properties.code as Record<string, unknown>).$anchor, undefined);
		assert.strictEqual((schema.properties.code as Record<string, unknown>).customFutureField, undefined);
		// 合法白名单字段必须完好保留
		assert.strictEqual(schema.properties.code.type, "string");
		assert.strictEqual(schema.properties.code.description, "代码内容");
	});

	test("清洗孤儿 required 属性：不在 properties 中的属性名自动剥离", () => {
		const schema = {
			type: "object",
			properties: {
				validField: { type: "string" },
			},
			required: ["validField", "ghostField1", "ghostField2"],
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.strictEqual(removed, 2, "应剥离 2 个不存在于 properties 的孤儿 required 项");
		assert.deepStrictEqual(schema.required, ["validField"], "仅保留真实存在的属性");
	});

	test("清洗孤儿 required 属性：全为孤儿时删除整个 required 字段", () => {
		const schema = {
			type: "object",
			properties: {
				validField: { type: "string" },
			},
			required: ["orphanField"],
		};

		const removed = stripUnsupportedGeminiSchemaKeys(schema);
		assert.strictEqual(removed, 1);
		assert.strictEqual((schema as Record<string, unknown>).required, undefined, "全部为孤儿时 required 字段应被删除");
	});
});
