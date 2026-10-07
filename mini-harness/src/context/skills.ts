/**
 * 第 5 章：skills —— 按需加载的指令包。
 *
 * 对应 pi 的 packages/coding-agent/src/core/skills.ts。
 *
 * 一个 skill 是一个目录，里面有 SKILL.md：
 *
 *   pdf-tools/
 *   ├── SKILL.md          ---\nname: pdf-tools\ndescription: ...\n---\n正文
 *   └── scripts/extract.sh
 *
 * system prompt 里只放 name + description + 路径 (几十个 token)。
 * 模型判断任务匹配时，自己用 read 工具读取 SKILL.md 正文。
 * 这就是"渐进式披露"：目录常驻上下文，正文按需进入。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	/** 为 true 时不出现在 system prompt 里，只能通过 /skill:name 显式调用。 */
	disableModelInvocation: boolean;
}

/** 解析简单的 YAML frontmatter (只支持 key: value 单行)。 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { data: {}, body: text };
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		data[line.slice(0, colon).trim()] = line
			.slice(colon + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return { data, body: text.slice(match[0].length) };
}

/** 递归扫描目录，找出所有 SKILL.md。 */
export function loadSkills(dirs: string[]): Skill[] {
	const skills = new Map<string, Skill>();
	const visit = (dir: string) => {
		if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
		const skillFile = join(dir, "SKILL.md");
		if (existsSync(skillFile)) {
			const { data } = parseFrontmatter(readFileSync(skillFile, "utf-8"));
			if (data.name && data.description) {
				// 后加载的同名 skill 覆盖先加载的 (项目级覆盖全局)。
				skills.set(data.name, {
					name: data.name,
					description: data.description,
					filePath: skillFile,
					disableModelInvocation: data["disable-model-invocation"] === "true",
				});
			}
			return;
		}
		for (const entry of readdirSync(dir)) {
			if (!entry.startsWith(".") && entry !== "node_modules") visit(join(dir, entry));
		}
	};
	for (const dir of dirs) visit(dir);
	return [...skills.values()];
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatSkillsForPrompt(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** 处理 /skill:name 参数：把 SKILL.md 正文直接作为用户消息发送，强制加载。 */
export function expandSkillCommand(text: string, skills: Skill[]): string | undefined {
	const match = text.match(/^\/skill:([\w-]+)\s*([\s\S]*)$/);
	if (!match) return undefined;
	const skill = skills.find((candidate) => candidate.name === match[1]);
	if (!skill) return undefined;
	const { body } = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
	const args = match[2].trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\n${body.trim()}\n</skill>${args ? `\n\n${args}` : ""}`;
}
