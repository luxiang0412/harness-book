/**
 * 第 3 章：edit 工具 —— 精确文本替换。
 *
 * 对应 pi 的 packages/coding-agent/src/core/tools/edit.ts 和 edit-diff.ts。
 *
 * 为什么不用行号？模型数行号经常出错，而且文件一改行号就变。
 * 为什么不用 unified diff？模型写的 diff 上下文行常常对不上。
 * "找到这段原文，替换成新文本"是最稳的协议，失败时也最容易解释。
 *
 * 规则：
 * - oldText 必须在文件中恰好出现一次，否则报错并让模型补充上下文；
 * - 一次调用可以包含多处修改，每处都相对原文件匹配，不能重叠；
 * - 精确匹配失败时，做一次宽松匹配 (忽略行尾空白、统一引号和破折号)。
 *   模型常把 ' 写成 ’，或者漏掉行尾空格。
 */

import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "../agent/types.ts";
import { withFileMutationQueue } from "./mutation-queue.ts";
import { resolvePath } from "./read.ts";

interface Edit {
	oldText: string;
	newText: string;
}

interface EditArgs {
	path: string;
	edits: Edit[];
}

export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/[  -   　]/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * 应用所有修改。返回新内容，或抛出一个模型能看懂、能据此修正的错误。
 * 使用了宽松匹配时，整个替换都在规范化后的文本上进行 (pi 会进一步保留未改动行的原始字节，这里简化)。
 */
export function applyEdits(original: string, edits: Edit[], path: string): string {
	if (edits.length === 0) throw new Error("edits must contain at least one replacement.");
	const exact = edits.every((edit) => edit.oldText.length > 0 && original.includes(edit.oldText));
	const base = exact ? original : normalizeForFuzzyMatch(original);

	const matches = edits.map((edit, index) => {
		if (!edit.oldText) throw new Error(`edits[${index}].oldText must not be empty in ${path}.`);
		const needle = exact ? edit.oldText : normalizeForFuzzyMatch(edit.oldText);
		const position = base.indexOf(needle);
		if (position === -1) {
			throw new Error(
				`Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}
		const occurrences = countOccurrences(base, needle);
		if (occurrences > 1) {
			throw new Error(
				`Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		}
		return { index, position, length: needle.length, newText: edit.newText };
	});

	matches.sort((a, b) => a.position - b.position);
	for (let i = 1; i < matches.length; i++) {
		const previous = matches[i - 1];
		if (previous.position + previous.length > matches[i].position) {
			throw new Error(`edits[${previous.index}] and edits[${matches[i].index}] overlap in ${path}. Merge them into one edit.`);
		}
	}

	// 从后往前替换，前面的位置不受影响。
	let result = base;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		result = result.slice(0, match.position) + match.newText + result.slice(match.position + match.length);
	}
	if (result === base) throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
	return result;
}

export function createEditTool(cwd: string): AgentTool<EditArgs> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit.",
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"Keep edits[].oldText as small as possible while still being unique in the file.",
		],
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
				edits: {
					type: "array",
					description: "One or more targeted replacements, each matched against the original file.",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", description: "Exact text to replace. Must be unique in the file." },
							newText: { type: "string", description: "Replacement text." },
						},
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
		async execute(_id, { path, edits }, signal) {
			const absolute = resolvePath(cwd, path);
			return withFileMutationQueue(absolute, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const raw = await readFile(absolute, "utf-8");
				// 统一成 LF 再匹配，写回时恢复原来的换行风格。
				const crlf = raw.includes("\r\n");
				const original = crlf ? raw.replace(/\r\n/g, "\n") : raw;
				const updated = applyEdits(
					original,
					edits.map((edit) => ({ oldText: edit.oldText.replace(/\r\n/g, "\n"), newText: edit.newText.replace(/\r\n/g, "\n") })),
					path,
				);
				await writeFile(absolute, crlf ? updated.replace(/\n/g, "\r\n") : updated, "utf-8");
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
					details: { before: original, after: updated },
				};
			});
		},
	};
}
