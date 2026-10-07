/**
 * 第 5 章：发现项目指令文件 (AGENTS.md / CLAUDE.md)。
 *
 * 对应 pi 的 packages/coding-agent/src/core/resource-loader.ts 中的 loadProjectContextFiles()。
 *
 * 查找顺序：
 * 1. 全局目录 (~/.mini/AGENTS.md)：个人偏好，对所有项目生效；
 * 2. 从 cwd 一直向上到文件系统根，每层目录最多取一个文件。
 *
 * 结果按"外层在前、内层在后"排列。内层 (更具体) 的指令排在后面，
 * 模型通常更重视后出现的内容，冲突时具体规则优先。
 *
 *   /repo/AGENTS.md            ← 第 2 个
 *   /repo/packages/AGENTS.md   ← 第 3 个
 *   cwd = /repo/packages/web   (没有 AGENTS.md)
 *   ~/.mini/AGENTS.md          ← 第 1 个
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

function loadFromDir(dir: string): ContextFile | undefined {
	for (const name of CANDIDATES) {
		const path = join(dir, name);
		if (existsSync(path) && statSync(path).isFile()) {
			return { path, content: readFileSync(path, "utf-8") };
		}
	}
	return undefined;
}

export function loadContextFiles(cwd: string, globalDir: string): ContextFile[] {
	const files: ContextFile[] = [];
	const global = loadFromDir(globalDir);
	if (global) files.push(global);

	const ancestors: ContextFile[] = [];
	let dir = resolve(cwd);
	while (true) {
		const file = loadFromDir(dir);
		if (file && file.path !== global?.path) ancestors.unshift(file);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...files, ...ancestors];
}
