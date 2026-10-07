/**
 * 第 16 章：崩溃恢复 —— 工具调用的意图日志。
 *
 * pi 的 packages/durable 把整个 harness 做成了持久化状态机：
 * 每一步 (生成、工具调用) 都是一个带检查点的任务，进程重启后从检查点继续。
 * 这里只演示其中最关键的一条规则。
 *
 * 问题：进程在执行 tool call 的过程中崩溃。重启后，这个调用要不要重新执行？
 *
 *   - 还没开始执行     → 可以执行，什么都还没发生
 *   - 已开始、未完成   → 不知道副作用有没有发生 (文件写了一半？邮件发出去了？)
 *                        只有声明为 replay: "safe" (幂等) 的工具才能重跑，
 *                        其他工具返回 "interrupted" 错误，让模型自己检查后决定
 *   - 已完成           → 结果已经在会话里，不用管
 *
 * 要区分前两种情况，必须在执行之前先把"意图"写进持久存储。这就是 write-ahead log。
 *
 *   会话文件:  assistant(toolCalls: A, B) → intent(A) → [崩溃]
 *   恢复:      A 已开始未完成 → 视 replay 决定；B 从未开始 → 直接执行
 */

import type { AgentTool } from "../agent/types.ts";
import type { ToolCall, ToolResultMessage } from "../ai/types.ts";
import type { SessionManager } from "../session/session-manager.ts";

export const TOOL_INTENT = "tool_intent";

/** 包装工具：执行前先把意图写进会话文件。 */
export function withIntentLog(tool: AgentTool & { replay?: "safe" | "never" }, session: SessionManager): AgentTool {
	return {
		...tool,
		async execute(toolCallId, args, signal, onUpdate) {
			session.appendCustom(TOOL_INTENT, { toolCallId, name: tool.name });
			return tool.execute(toolCallId, args, signal, onUpdate);
		},
	};
}

export interface RecoveryReport {
	rerun: string[];
	interrupted: string[];
}

/**
 * 检查当前分支最后一条带 tool call 的 assistant 消息，补齐缺失的工具结果。
 * 返回后，上下文以 toolResult 结尾，可以直接 agent.continue()。
 */
export async function recoverInterruptedToolCalls(
	session: SessionManager,
	tools: (AgentTool & { replay?: "safe" | "never" })[],
): Promise<RecoveryReport> {
	const report: RecoveryReport = { rerun: [], interrupted: [] };
	const path = session.getPath();
	let index = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			index = i;
			break;
		}
	}
	if (index === -1) return report;
	const assistant = path[index];
	if (assistant.type !== "message" || assistant.message.role !== "assistant") return report;
	const calls = assistant.message.content.filter((block): block is ToolCall => block.type === "toolCall");
	if (calls.length === 0) return report;

	const answered = new Set<string>();
	const started = new Set<string>();
	for (const entry of path.slice(index + 1)) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
		if (entry.type === "custom" && entry.customType === TOOL_INTENT) started.add((entry.data as { toolCallId: string }).toolCallId);
	}

	for (const call of calls) {
		if (answered.has(call.id)) continue;
		const tool = tools.find((candidate) => candidate.name === call.name);
		const canRun = tool && (!started.has(call.id) || tool.replay === "safe");
		let result: ToolResultMessage;
		if (canRun) {
			report.rerun.push(call.id);
			try {
				const output = await tool.execute(call.id, call.arguments, undefined, () => {});
				result = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: output.content, isError: output.isError === true, timestamp: Date.now() };
			} catch (error) {
				result = errorResult(call, error instanceof Error ? error.message : String(error));
			}
		} else {
			report.interrupted.push(call.id);
			result = errorResult(
				call,
				"Tool call was interrupted: the process exited while it was running, so its effects are unknown. Check the current state before retrying.",
			);
		}
		session.appendMessage(result);
	}
	return report;
}

function errorResult(call: ToolCall, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: true, timestamp: Date.now() };
}
