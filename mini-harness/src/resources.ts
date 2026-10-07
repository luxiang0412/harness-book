/**
 * 第 5 章 / 第 13 章：收集所有资源。
 *
 * 对应 pi 的 packages/coding-agent/src/core/resource-loader.ts。
 * 全局资源总是加载；项目资源 (.mini/ 下) 只在信任后加载。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_CONFIG_DIR } from "./config.ts";
import { type ContextFile, loadContextFiles } from "./context/context-files.ts";
import { loadPromptTemplates, type PromptTemplate } from "./context/prompt-templates.ts";
import { loadSkills, type Skill } from "./context/skills.ts";
import { discoverExtensions } from "./extensions/loader.ts";

export interface Resources {
	contextFiles: ContextFile[];
	skills: Skill[];
	templates: PromptTemplate[];
	extensionPaths: string[];
	customPrompt?: string;
	appendPrompt?: string;
}

function readOptional(...paths: string[]): string | undefined {
	for (const path of paths) {
		if (existsSync(path)) return readFileSync(path, "utf-8");
	}
	return undefined;
}

export function loadResources(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	extraExtensions?: string[];
	noContextFiles?: boolean;
}): Resources {
	const { agentDir, cwd, projectTrusted } = options;
	const project = join(cwd, PROJECT_CONFIG_DIR);
	const scopes = projectTrusted ? [agentDir, project] : [agentDir];
	return {
		contextFiles: options.noContextFiles ? [] : loadContextFiles(cwd, agentDir),
		// 后面的目录覆盖前面的同名资源：项目级优先。
		skills: loadSkills(scopes.map((dir) => join(dir, "skills"))),
		templates: loadPromptTemplates(scopes.map((dir) => join(dir, "prompts"))),
		extensionPaths: [...scopes.flatMap((dir) => discoverExtensions(join(dir, "extensions"))), ...(options.extraExtensions ?? [])],
		customPrompt: readOptional(...(projectTrusted ? [join(project, "SYSTEM.md")] : []), join(agentDir, "SYSTEM.md")),
		appendPrompt: readOptional(...(projectTrusted ? [join(project, "APPEND_SYSTEM.md")] : []), join(agentDir, "APPEND_SYSTEM.md")),
	};
}
