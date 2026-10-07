/**
 * 第 5 章：system prompt 的拼装。
 *
 * 对应 pi 的 packages/coding-agent/src/core/system-prompt.ts。
 *
 * prompt 由有序的 section 组成，除 preamble 外每段都包在同名 XML 标签里：
 *
 *   preamble          身份声明
 *   <tools>           每个工具一行简介
 *   <rules>           工具贡献的规则 + 通用规则
 *   <addendum>        用户追加的内容 (APPEND_SYSTEM.md)
 *   <project_context> AGENTS.md
 *   <skills>          skill 目录
 *   <cwd>             工作目录
 *
 * 分段的好处：
 * - 规则跟着工具走：禁用 edit，edit 的规则自动消失；
 * - 可以只更新某一段 (diffSections)，见第 5 章 "增量更新"。
 */

import type { AgentTool } from "../agent/types.ts";
import type { ContextFile } from "./context-files.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	cwd: string;
	tools: AgentTool[];
	/** 替换默认 preamble (SYSTEM.md)。替换后不再生成 tools/rules。 */
	customPrompt?: string;
	/** 追加内容 (APPEND_SYSTEM.md)。 */
	appendPrompt?: string;
	contextFiles?: ContextFile[];
	skills?: Skill[];
	/** 扩展追加的规则 (第 10 章)。 */
	extraGuidelines?: string[];
	/** 扩展追加的整段内容 (第 10 章)。 */
	extraSections?: Record<string, string>;
}

export type SystemPromptSections = Record<string, string>;

const PREAMBLE =
	"You are an expert coding assistant operating inside mini-harness. You help users by reading files, executing commands, editing code, and writing new files.";

function buildRules(tools: AgentTool[], extra: string[]): string {
	const rules: string[] = [];
	const add = (rule: string) => {
		const normalized = rule.trim();
		if (normalized && !rules.includes(normalized)) rules.push(normalized);
	};
	const names = new Set(tools.map((tool) => tool.name));
	if (names.has("bash") && !names.has("grep") && !names.has("find")) {
		add("Use bash for file operations like ls, rg, find");
	}
	for (const tool of tools) for (const rule of tool.promptGuidelines ?? []) add(rule);
	for (const rule of extra) add(rule);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

export function buildSystemPromptSections(options: BuildSystemPromptOptions): SystemPromptSections {
	const raw: Record<string, string> = {};
	if (options.customPrompt) {
		raw.preamble = options.customPrompt;
	} else {
		raw.preamble = PREAMBLE;
		const listed = options.tools.filter((tool) => tool.promptSnippet);
		const toolLines = listed.length > 0 ? listed.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`).join("\n") : "(none)";
		raw.tools = `${toolLines}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		raw.rules = buildRules(options.tools, options.extraGuidelines ?? []);
	}
	if (options.appendPrompt) raw.addendum = options.appendPrompt;
	if (options.contextFiles && options.contextFiles.length > 0) {
		raw.project_context = [
			"Project-specific instructions and guidelines:",
			...options.contextFiles.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`),
		].join("\n\n");
	}
	// 没有 read 工具时模型无法读取 skill 正文，列出来也没用。
	if (options.tools.some((tool) => tool.name === "read") && options.skills) {
		const skills = formatSkillsForPrompt(options.skills);
		if (skills) raw.skills = skills;
	}
	raw.cwd = options.cwd;
	for (const [name, content] of Object.entries(options.extraSections ?? {})) {
		if (content) raw[name] = content;
	}

	const sections: SystemPromptSections = { preamble: raw.preamble };
	for (const [name, content] of Object.entries(raw)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

export function renderSystemPrompt(sections: SystemPromptSections): string {
	return Object.values(sections).join("\n\n");
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return renderSystemPrompt(buildSystemPromptSections(options));
}

/**
 * 计算两版 sections 的差异：变化的段给出新内容，删除的段记为 null。
 * pi 用它在会话中途追加一条只含差异的 system 消息，而不改写开头的 prompt，
 * 这样 provider 的 prompt cache 前缀保持不变。
 */
export function diffSections(
	previous: SystemPromptSections,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

/** 把差异渲染成一段文字，作为会话中途的 system 更新发给模型。 */
export function renderSectionUpdate(patch: Record<string, string | null>): string {
	return Object.entries(patch)
		.map(([name, value]) =>
			value === null ? `Removed system prompt section "${name}".` : `Updated system prompt section "${name}":\n\n${value}`,
		)
		.join("\n\n");
}
