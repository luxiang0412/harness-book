/**
 * 第 17 章：code mode —— 让模型写脚本来调用工具。
 *
 * 对应 pi 的 packages/codemode (QuickJS WASM 沙箱) 和
 * packages/coding-agent/src/extensions/codemode/tool.ts。
 *
 * 普通方式：模型想对 20 个文件各 grep 一次，要发 20 个 tool call，
 * 每个结果都进入上下文，中间还可能来回好几轮。
 *
 * code mode：模型写一段脚本，
 *
 *   const files = (await tools.bash({ command: "ls src" })).split("\n");
 *   for (const f of files) {
 *     const out = await tools.bash({ command: `grep -c TODO src/${f}` });
 *     if (out.trim() !== "0") text(`${f}: ${out.trim()}`);
 *   }
 *
 * 脚本里的工具调用不进入模型上下文，只有 text() 的输出和返回值进入。
 *
 * ⚠ node:vm 不是安全边界。脚本可以通过原型链逃逸到宿主进程。
 *   这里只用来演示数据流。pi 用 QuickJS 编译成的 WebAssembly 隔离脚本：
 *   脚本唯一的能力就是调用注入的工具，没有文件、网络、定时器。
 */

import { createContext, Script } from "node:vm";
import { runToolCall } from "../agent/loop.ts";
import type { AgentLoopConfig, AgentTool } from "../agent/types.ts";
import { contentText } from "../ai/types.ts";

export interface CodeModeHost {
	/** 脚本可以调用的工具 (不含 codemode 自身)。 */
	getTools(): AgentTool[];
	/** 复用 agent 的钩子：权限扩展对脚本里的调用同样生效。 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];
}

const TIMEOUT_MS = 60_000;

export function toIdentifier(name: string): string {
	const replaced = name.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
}

export function createCodeModeTool(host: CodeModeHost): AgentTool<{ code: string }> {
	return {
		name: "codemode",
		label: "codemode",
		description: [
			"Run JavaScript that calls other tools. The input is the body of an async function: top-level await and return work.",
			"- `await tools.<name>({ ...args })` resolves to the tool's text output and rejects with an Error on failure.",
			"- `text(value)` appends output. The return value is appended too. Nothing else reaches the conversation.",
			"- No require, fetch, process, or timers.",
			"Use it to batch independent calls (Promise.all), chain calls, or filter large output.",
		].join("\n"),
		promptSnippet: "Run JavaScript that calls other tools",
		promptGuidelines: ["Use codemode to batch independent tool calls, chain them, or filter large output, instead of many separate calls."],
		parameters: {
			type: "object",
			properties: { code: { type: "string", description: "JavaScript async function body" } },
			required: ["code"],
		},
		async execute(toolCallId, { code }, signal) {
			const output: string[] = [];
			const calls: string[] = [];
			let callIndex = 0;
			const tools = host.getTools().filter((tool) => tool.name !== "codemode");
			const context = { systemPrompt: "", messages: [], tools };

			const bindings: Record<string, (args: unknown) => Promise<string>> = {};
			for (const tool of tools) {
				bindings[toIdentifier(tool.name)] = async (args: unknown) => {
					// 参数来自另一个 JS 上下文，先做一次 JSON 往返，得到宿主上下文里的普通对象。
					const plainArgs = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
					calls.push(tool.name);
					const { result, isError } = await runToolCall(
						{ type: "toolCall", id: `${toolCallId}:${callIndex++}`, name: tool.name, arguments: plainArgs },
						context,
						{ beforeToolCall: host.beforeToolCall, afterToolCall: host.afterToolCall },
						signal,
					);
					const text = contentText(result.content);
					if (isError) throw new Error(text);
					return text;
				};
			}

			const sandbox = createContext({
				tools: Object.freeze(bindings),
				text: (value: unknown) => {
					output.push(typeof value === "string" ? value : JSON.stringify(value, null, 2));
				},
			});

			let timer: NodeJS.Timeout | undefined;
			try {
				// timeout 只限制同步部分 (例如死循环)；异步部分用下面的 race 限制。
				const promise = new Script(`(async () => {\n${code}\n})()`).runInContext(sandbox, { timeout: 5_000 }) as Promise<unknown>;
				const value = await Promise.race([
					promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`Script timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
						signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
					}),
				]);
				if (value !== undefined) output.push(typeof value === "string" ? value : JSON.stringify(value, null, 2));
				return {
					content: [{ type: "text", text: output.join("\n") || "(no output)" }],
					details: { calls },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: [...output, `Error: ${message}`].join("\n") }], details: { calls }, isError: true };
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
