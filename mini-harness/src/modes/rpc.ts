/**
 * 第 9 章：RPC 模式 —— 用 stdin/stdout 上的 JSONL 控制 harness。
 *
 * 对应 pi 的 packages/coding-agent/src/modes/rpc/rpc-mode.ts。
 * 适合其他语言的程序、IDE 插件把 harness 当子进程来用。
 *
 *   stdin  → {"id":"1","type":"prompt","message":"hi"}
 *   stdout ← {"id":"1","type":"response","command":"prompt","success":true}
 *   stdout ← {"type":"agent_start"} {"type":"message_update",…} … {"type":"agent_end",…}
 *
 * 两条规则：
 * - prompt 的响应只表示"已接受"，不表示"已完成"。完成要等 agent_end 事件；
 * - 按 \n 切分记录，不能用 readline：它还会在 U+2028/U+2029 处切开，
 *   而这两个字符可以合法地出现在 JSON 字符串里。
 */

import { findModel } from "../ai/models.ts";
import type { AgentSession } from "../session/agent-session.ts";
import { toJsonEvent } from "./json-event.ts";

type RpcCommand =
	| { id?: string; type: "prompt"; message: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "follow_up"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_model"; model: string };

function send(record: unknown): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

export async function runRpcMode(session: AgentSession): Promise<void> {
	session.subscribe((event) => send(toJsonEvent(event)));

	const handle = async (command: RpcCommand): Promise<unknown> => {
		switch (command.type) {
			case "prompt":
				if (session.agent.state.isRunning) throw new Error("Agent is running; use steer or follow_up");
				// 不等待完成：立即响应，进度通过事件流报告。
				void session.prompt(command.message).catch((error) => send({ type: "error", error: String(error) }));
				return undefined;
			case "steer":
				session.steer(command.message);
				return undefined;
			case "follow_up":
				session.followUp(command.message);
				return undefined;
			case "abort":
				session.abort();
				return undefined;
			case "get_state":
				return {
					model: `${session.model.provider}/${session.model.id}`,
					isRunning: session.agent.state.isRunning,
					sessionFile: session.sessionManager.file,
					messageCount: session.messages.length,
					contextUsage: session.getContextUsage(),
				};
			case "get_messages":
				return { messages: session.messages };
			case "compact":
				return { compacted: await session.compact(command.customInstructions) };
			case "set_model": {
				const model = findModel(command.model);
				if (!model) throw new Error(`Model not found: ${command.model}`);
				session.setModel(model);
				return undefined;
			}
		}
	};

	let buffer = "";
	process.stdin.setEncoding("utf-8");
	for await (const chunk of process.stdin) {
		buffer += chunk as string;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			let command: RpcCommand;
			try {
				command = JSON.parse(line) as RpcCommand;
			} catch {
				send({ type: "response", success: false, error: "Invalid JSON" });
				continue;
			}
			try {
				const data = await handle(command);
				send({ id: command.id, type: "response", command: command.type, success: true, ...(data ? { data } : {}) });
			} catch (error) {
				send({ id: command.id, type: "response", command: command.type, success: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	await session.agent.waitForIdle();
}
