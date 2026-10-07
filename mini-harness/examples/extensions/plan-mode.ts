/**
 * 第 11 章示例：plan mode —— pi 没有内置，交给扩展实现。
 *
 * /plan 进入规划模式：只保留只读工具，并在 system prompt 里要求先给计划；
 * /plan 再次输入则退出，恢复全部工具。
 * 状态写进会话 (appendEntry)，恢复会话时能读回来。
 *
 *   node src/main.ts -e examples/extensions/plan-mode.ts
 */

import type { ExtensionAPI } from "../../src/extensions/types.ts";

const READ_ONLY = ["read"];

export default function (mini: ExtensionAPI) {
	let planning = false;
	let savedTools: string[] = [];

	mini.on("session_start", async (_event, ctx) => {
		// 从会话里恢复上一次的状态。
		for (const entry of ctx.sessionManager.getPath()) {
			if (entry.type === "custom" && entry.customType === "plan-mode") planning = (entry.data as { planning: boolean }).planning;
		}
		if (planning) {
			savedTools = mini.getAllTools();
			mini.setActiveTools(READ_ONLY);
		}
	});

	mini.registerCommand("plan", {
		description: "Toggle read-only planning mode",
		handler: async (_args, ctx) => {
			planning = !planning;
			if (planning) {
				savedTools = mini.getActiveTools();
				mini.setActiveTools(READ_ONLY);
			} else {
				mini.setActiveTools(savedTools.length > 0 ? savedTools : mini.getAllTools());
			}
			mini.appendEntry("plan-mode", { planning });
			ctx.ui.notify(planning ? "Plan mode ON: read-only tools, propose a plan first." : "Plan mode OFF.");
		},
	});

	mini.on("before_agent_start", async (event) => {
		if (!planning) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<plan_mode>\nYou are in planning mode. Do not modify files. Investigate with read-only tools, then reply with a numbered implementation plan and wait for approval.\n</plan_mode>`,
		};
	});

	// 双保险：即使模型绕过提示调用写工具，也在这里拦下。
	mini.on("tool_call", async (event) => {
		if (planning && !READ_ONLY.includes(event.toolName)) {
			return { block: true, reason: `Plan mode: ${event.toolName} is not allowed. Propose a plan instead.` };
		}
		return undefined;
	});
}
