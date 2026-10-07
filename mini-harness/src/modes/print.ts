/**
 * 第 9 章：print 模式和 JSON 模式。
 *
 * 对应 pi 的 packages/coding-agent/src/modes/print-mode.ts。
 *
 *   mini -p "解释这个仓库"            → 只输出最终回答 (适合 shell 管道)
 *   mini --mode json "解释这个仓库"    → 每个事件一行 JSON (适合程序解析)
 *
 * 两者共用同一个 AgentSession，区别只在于订阅事件后怎么输出。
 */

import type { AgentSession } from "../session/agent-session.ts";
import { toJsonEvent } from "./json-event.ts";

export async function runPrintMode(session: AgentSession, prompt: string, mode: "text" | "json"): Promise<number> {
	if (mode === "json") {
		session.subscribe((event) => {
			process.stdout.write(`${JSON.stringify(toJsonEvent(event))}\n`);
		});
	}
	await session.prompt(prompt);

	const last = session.lastAssistant();
	if (!last) return 0; // 输入被扩展命令处理掉了，没有模型回复
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		console.error(last.errorMessage ?? `Request ${last.stopReason}`);
		return 1;
	}
	if (mode === "text") {
		for (const block of last.content) {
			if (block.type === "text") process.stdout.write(`${block.text}\n`);
		}
	}
	return 0;
}
