/**
 * 配置目录与设置。
 *
 * 目录布局 (仿照 pi 的 ~/.pi/agent 和 <project>/.pi)：
 *
 *   ~/.mini/                     全局 (可用 MINI_HOME 覆盖)
 *   ├── settings.json
 *   ├── AGENTS.md                全局指令
 *   ├── SYSTEM.md / APPEND_SYSTEM.md
 *   ├── extensions/  skills/  prompts/
 *   ├── trust.json               项目信任决定 (第 13 章)
 *   └── sessions/<cwd>/*.jsonl   会话 (第 6 章)
 *
 *   <project>/.mini/             项目级，需要信任后才加载
 *   ├── settings.json  mcp.json
 *   ├── SYSTEM.md / APPEND_SYSTEM.md
 *   └── extensions/  skills/  prompts/
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.MINI_HOME ?? join(homedir(), ".mini");
}

export const PROJECT_CONFIG_DIR = ".mini";

export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface Settings {
	defaultModel?: string;
	compaction: CompactionSettings;
	retry: RetrySettings;
	/** 没有保存过信任决定时怎么办 (第 13 章)。 */
	defaultProjectTrust: "ask" | "always" | "never";
}

export const DEFAULT_SETTINGS: Settings = {
	compaction: DEFAULT_COMPACTION_SETTINGS,
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
	defaultProjectTrust: "ask",
};

function readJson(path: string): Record<string, any> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
	} catch {
		return {};
	}
}

/** 全局设置 + (信任后) 项目设置，项目设置覆盖全局。嵌套对象按字段合并。 */
export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): Settings {
	const global = readJson(join(agentDir, "settings.json"));
	const project = projectTrusted ? readJson(join(cwd, PROJECT_CONFIG_DIR, "settings.json")) : {};
	const merged = { ...global, ...project };
	return {
		defaultModel: merged.defaultModel,
		compaction: { ...DEFAULT_SETTINGS.compaction, ...global.compaction, ...project.compaction },
		retry: { ...DEFAULT_SETTINGS.retry, ...global.retry, ...project.retry },
		defaultProjectTrust: global.defaultProjectTrust ?? DEFAULT_SETTINGS.defaultProjectTrust,
	};
}
