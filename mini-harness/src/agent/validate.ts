/**
 * 第 3 章：工具参数校验。
 *
 * 模型生成的参数不一定符合 schema：漏字段、类型错、把数组写成字符串。
 * 校验失败时不执行工具，而是把错误信息作为工具结果返回给模型，
 * 模型看到错误后通常会自己修正参数重试。
 *
 * pi 用 typebox 的编译校验器 (packages/ai/src/utils/validation.ts)。
 * 这里实现一个够用的子集：type / required / properties / items / enum。
 */

import type { JsonSchema } from "../ai/types.ts";

export function validateArguments(schema: JsonSchema, value: unknown, path = "arguments"): string[] {
	const errors: string[] = [];
	if (schema.type && !matchesType(schema.type, value)) {
		errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`);
		return errors;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
	}
	if (schema.type === "object" && value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (record[key] === undefined) errors.push(`${path}.${key}: required`);
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (record[key] !== undefined) errors.push(...validateArguments(child, record[key], `${path}.${key}`));
		}
	}
	if (schema.type === "array" && Array.isArray(value) && schema.items) {
		value.forEach((item, index) => {
			errors.push(...validateArguments(schema.items as JsonSchema, item, `${path}[${index}]`));
		});
	}
	return errors;
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		default:
			return true;
	}
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
