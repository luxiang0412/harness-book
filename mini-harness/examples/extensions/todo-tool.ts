/**
 * 第 11 章示例：带状态的自定义工具。
 *
 * 模型用 todo 工具维护任务清单。状态除了放在扩展内存里，每次变化都写进会话 (appendEntry)：
 * 恢复会话或切换分支后，沿当前分支的历史重建状态，分支之间互不干扰。
 * pi 的 examples/extensions/todo.ts 用同样的思路，只是把状态放在工具结果的 details 里。
 *
 *   node src/main.ts -e examples/extensions/todo-tool.ts
 */

import type { ExtensionAPI } from "../../src/extensions/types.ts";
import type { SessionManager } from "../../src/session/session-manager.ts";

interface Todo {
	text: string;
	done: boolean;
}

function restore(session: SessionManager): Todo[] {
	let todos: Todo[] = [];
	for (const entry of session.getPath()) {
		if (entry.type === "custom" && entry.customType === "todo-state") todos = (entry.data as { todos: Todo[] }).todos;
	}
	return todos;
}

export default function (mini: ExtensionAPI) {
	let todos: Todo[] = [];

	mini.on("session_start", async (_event, ctx) => {
		todos = restore(ctx.sessionManager);
	});

	mini.registerTool({
		name: "todo",
		label: "todo",
		description: "Manage a task list. action=add (text), done (index), list.",
		promptSnippet: "Track multi-step work in a todo list",
		promptGuidelines: ["For tasks with 3+ steps, add them to the todo list first and mark each done as you finish it."],
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["add", "done", "list"] },
				text: { type: "string" },
				index: { type: "number" },
			},
			required: ["action"],
		},
		async execute(_id, args: { action: string; text?: string; index?: number }) {
			if (args.action === "add" && args.text) todos = [...todos, { text: args.text, done: false }];
			if (args.action === "done" && args.index !== undefined) {
				todos = todos.map((todo, i) => (i === args.index ? { ...todo, done: true } : todo));
			}
			mini.appendEntry("todo-state", { todos });
			const list = todos.map((todo, i) => `${i}. [${todo.done ? "x" : " "}] ${todo.text}`).join("\n") || "(empty)";
			return { content: [{ type: "text", text: list }], details: { todos } };
		},
	});
}
