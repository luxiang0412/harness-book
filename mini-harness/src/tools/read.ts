/**
 * 第 3 章：read 工具。
 *
 * 对应 pi 的 packages/coding-agent/src/core/tools/read.ts。
 *
 * 设计要点：
 * - offset/limit 分页读取，大文件不必一次读完；
 * - 截断后告诉模型下一步怎么做 ("Use offset=2001 to continue")，
 *   而不是只说"被截断了"。可操作的提示能省掉一轮试错。
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AgentTool } from "../agent/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

interface ReadArgs {
	path: string;
	offset?: number;
	limit?: number;
}

export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function createReadTool(cwd: string): AgentTool<ReadArgs> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to read (relative or absolute)" },
				offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
				limit: { type: "number", description: "Maximum number of lines to read" },
			},
			required: ["path"],
		},
		async execute(_id, { path, offset, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const text = await readFile(resolvePath(cwd, path), "utf-8");
			const allLines = text.split("\n");
			const start = offset ? Math.max(0, offset - 1) : 0;
			if (start >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}
			const end = limit !== undefined ? Math.min(start + limit, allLines.length) : allLines.length;
			const selected = allLines.slice(start, end).join("\n");
			const truncation = truncateHead(selected);

			let output = truncation.content;
			if (truncation.truncated) {
				const lastShown = start + truncation.outputLines;
				const reason = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
				output += `\n\n[Showing lines ${start + 1}-${lastShown} of ${allLines.length}${reason}. Use offset=${lastShown + 1} to continue.]`;
			} else if (end < allLines.length) {
				output += `\n\n[${allLines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
			}
			return { content: [{ type: "text", text: output }], details: { truncated: truncation.truncated } };
		},
	};
}
