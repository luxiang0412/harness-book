/**
 * 第 3 章：write 工具。新建文件或整体重写。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "../agent/types.ts";
import { withFileMutationQueue } from "./mutation-queue.ts";
import { resolvePath } from "./read.ts";

interface WriteArgs {
	path: string;
	content: string;
}

export function createWriteTool(cwd: string): AgentTool<WriteArgs> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it does not exist, overwrites it if it does. Creates parent directories as needed.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to write (relative or absolute)" },
				content: { type: "string", description: "Content to write to the file" },
			},
			required: ["path", "content"],
		},
		async execute(_id, { path, content }, signal) {
			const absolute = resolvePath(cwd, path);
			return withFileMutationQueue(absolute, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, content, "utf-8");
				return { content: [{ type: "text", text: `Successfully wrote ${content.length} characters to ${path}` }] };
			});
		},
	};
}
