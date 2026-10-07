/**
 * 第 5 章：prompt 模板 —— 可复用的 /命令。
 *
 * 对应 pi 的 packages/coding-agent/src/core/prompt-templates.ts。
 *
 * ~/.mini/prompts/review.md:
 *   ---
 *   description: Review staged changes
 *   ---
 *   Review the staged changes. Focus on ${1:-correctness}.
 *
 * 输入 "/review security" 展开成 "Review the staged changes. Focus on security."
 * 模板在用户消息发出之前展开，模型只看到展开后的文本。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./skills.ts";

export interface PromptTemplate {
	name: string;
	description: string;
	body: string;
}

export function loadPromptTemplates(dirs: string[]): PromptTemplate[] {
	const templates = new Map<string, PromptTemplate>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const { data, body } = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
			const name = basename(file, ".md");
			const description = data.description ?? body.split("\n").find((line) => line.trim()) ?? "";
			templates.set(name, { name, description, body: body.trim() });
		}
	}
	return [...templates.values()];
}

/** 支持 $1、$2、$@ (全部参数) 和 ${1:-默认值}。 */
export function expandTemplate(text: string, templates: PromptTemplate[]): string | undefined {
	const match = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	const template = templates.find((candidate) => candidate.name === match[1]);
	if (!template) return undefined;
	const rawArgs = match[2]?.trim() ?? "";
	const args = rawArgs ? rawArgs.split(/\s+/) : [];
	return template.body
		.replace(/\$\{(\d+):-([^}]*)\}/g, (_, index: string, fallback: string) => args[Number(index) - 1] ?? fallback)
		.replace(/\$@/g, rawArgs)
		.replace(/\$(\d+)/g, (_, index: string) => args[Number(index) - 1] ?? "");
}
