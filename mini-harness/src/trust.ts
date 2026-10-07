/**
 * 第 13 章：项目信任。
 *
 * 对应 pi 的 packages/coding-agent/src/core/trust-manager.ts。
 *
 * 问题：你 clone 了一个陌生仓库，里面有 .mini/extensions/evil.ts。
 * 如果启动时自动加载，这段代码就以你的权限运行了。
 *
 * 规则：项目目录里有"可执行或会改变 harness 行为"的资源时，
 * 必须先得到信任决定，才加载这些资源。
 *
 * 注意 AGENTS.md 不受信任控制：它只是文本，会照常加载。
 * 但这不代表它安全，文本同样可以通过 prompt injection 影响模型 (第 13 章)。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_CONFIG_DIR } from "./config.ts";

const PROTECTED_RESOURCES = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "SYSTEM.md", "APPEND_SYSTEM.md"];

type TrustFile = Record<string, boolean>;

function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

/** 项目里有没有需要信任才能加载的资源。只有一个空的 .mini 目录不算。 */
export function hasProtectedResources(cwd: string): boolean {
	return PROTECTED_RESOURCES.some((name) => existsSync(join(cwd, PROJECT_CONFIG_DIR, name)));
}

function readTrustFile(agentDir: string): TrustFile {
	const path = join(agentDir, "trust.json");
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as TrustFile;
	} catch {
		return {};
	}
}

/** 从 cwd 向上找最近的已保存决定。信任 ~/code 意味着信任它下面的所有项目。 */
export function getSavedTrust(agentDir: string, cwd: string): boolean | undefined {
	const data = readTrustFile(agentDir);
	let dir = canonical(cwd);
	while (true) {
		if (typeof data[dir] === "boolean") return data[dir];
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function saveTrust(agentDir: string, path: string, trusted: boolean): void {
	const data = readTrustFile(agentDir);
	data[canonical(path)] = trusted;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify(data, null, 2)}\n`);
}

export interface TrustOptions {
	agentDir: string;
	cwd: string;
	/** 命令行 --approve / --no-approve。 */
	override?: boolean;
	defaultTrust: "ask" | "always" | "never";
	/** 交互模式下询问用户；非交互模式为 undefined。 */
	ask?: (cwd: string) => Promise<boolean>;
}

/**
 * 决策顺序：
 *   1. 没有受保护资源 → 无需决定
 *   2. 命令行覆盖
 *   3. 已保存的决定 (最近的祖先目录)
 *   4. 默认策略；"ask" 且能交互时询问，不能交互时视为拒绝
 */
export async function resolveProjectTrust(options: TrustOptions): Promise<boolean> {
	if (!hasProtectedResources(options.cwd)) return false;
	if (options.override !== undefined) return options.override;
	const saved = getSavedTrust(options.agentDir, options.cwd);
	if (saved !== undefined) return saved;
	if (options.defaultTrust === "always") return true;
	if (options.defaultTrust === "never" || !options.ask) return false;
	const decision = await options.ask(options.cwd);
	saveTrust(options.agentDir, options.cwd, decision);
	return decision;
}
