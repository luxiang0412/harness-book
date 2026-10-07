/**
 * 第 10 章：加载扩展。
 *
 * 对应 pi 的 packages/coding-agent/src/core/extensions/loader.ts。
 *
 * pi 用 jiti 加载 TypeScript 源码，并通过 alias / virtual modules 让扩展
 * import "@earendil-works/pi-coding-agent" 时拿到宿主进程里的同一份模块。
 * mini-harness 直接用 Node 22 的原生 TypeScript 支持 + 动态 import()。
 *
 * 加载过程：
 *   1. 发现：扫描扩展目录，单文件 *.ts 或带 index.ts 的子目录；
 *   2. 导入：import() 模块，取默认导出的工厂函数；
 *   3. 初始化：创建一个空的 Extension 记录，构造 API，调用工厂；
 *      工厂里的 on() / registerTool() 写进这条记录；
 *   4. 隔离：一个扩展加载失败不影响其他扩展，错误收集后统一报告。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, ExtensionActions, ExtensionAPI, ExtensionFactory } from "./types.ts";

export interface LoadResult {
	extensions: Extension[];
	errors: { path: string; error: string }[];
}

/** 运行时动作在加载阶段还不可用：会话还没创建。AgentSession 绑定后才替换成真实实现。 */
export function createPendingActions(): ExtensionActions {
	const notReady = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called while extensions are loading.");
	};
	return {
		sendUserMessage: notReady,
		appendEntry: notReady,
		setActiveTools: notReady,
		getActiveTools: notReady,
		getAllTools: notReady,
	};
}

function createExtensionAPI(extension: Extension, actions: ExtensionActions): ExtensionAPI {
	return {
		on(event, handler) {
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
			return () => {
				const index = list.indexOf(handler);
				if (index !== -1) list.splice(index, 1);
			};
		},
		registerTool(tool) {
			if (tool.parameters?.type !== "object") {
				throw new Error(`Tool "${tool.name}" from ${extension.path} must define an object parameter schema.`);
			}
			extension.tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			extension.commands.set(name, { name, ...options });
		},
		// 运行时动作通过 actions 间接调用：actions 对象的方法在绑定后会被替换。
		sendUserMessage: (text) => actions.sendUserMessage(text),
		appendEntry: (customType, data) => actions.appendEntry(customType, data),
		setActiveTools: (names) => actions.setActiveTools(names),
		getActiveTools: () => actions.getActiveTools(),
		getAllTools: () => actions.getAllTools(),
	};
}

export async function loadExtensionFromFactory(factory: ExtensionFactory, path: string, actions: ExtensionActions): Promise<Extension> {
	const extension: Extension = { path, handlers: new Map(), tools: new Map(), commands: new Map() };
	await factory(createExtensionAPI(extension, actions));
	return extension;
}

export async function loadExtensions(paths: string[], actions: ExtensionActions): Promise<LoadResult> {
	const result: LoadResult = { extensions: [], errors: [] };
	for (const path of paths) {
		try {
			const module = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
			if (typeof module.default !== "function") {
				throw new Error("Extension does not export a default factory function");
			}
			result.extensions.push(await loadExtensionFromFactory(module.default as ExtensionFactory, path, actions));
		} catch (error) {
			result.errors.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

/** 扫描目录：直接的 .ts/.js 文件，或者包含 index.ts/index.js 的子目录。 */
export function discoverExtensions(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			for (const index of ["index.ts", "index.js"]) {
				if (existsSync(join(path, index))) {
					found.push(join(path, index));
					break;
				}
			}
		} else if (/\.(ts|js|mjs)$/.test(name)) {
			found.push(path);
		}
	}
	return found;
}
