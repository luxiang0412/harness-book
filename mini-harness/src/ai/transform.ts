/**
 * 第 1 章：发送前的消息清洗。
 *
 * 对应 pi 的 packages/ai/src/api/transform-messages.ts。
 *
 * 会话历史里可能有 provider 不接受的形态，发送前统一修正：
 *
 * 1. 失败或被中断的 assistant 消息：内容可能残缺 (半截 tool call)，直接丢弃。
 * 2. 孤儿 tool call：assistant 发起了 tool call，但历史里没有对应的结果
 *    (例如执行到一半被用户中断)。所有主流 API 都要求每个 tool call 都有结果，
 *    所以补一条 "No result provided" 的错误结果。
 * 3. 跨模型回放：thinking 的签名只对产生它的模型有效。
 *    换了模型就丢弃 thinking：签名会被 API 拒绝，转成普通文本又会让新模型
 *    把旧模型的推理当成自己回答的一部分。
 */

import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "./types.ts";

export function transformMessages(messages: Message[], model: Model): Message[] {
	const result: Message[] = [];
	let pending: ToolCall[] = [];
	let answered = new Set<string>();

	const closePending = () => {
		for (const call of pending) {
			if (answered.has(call.id)) continue;
			const synthetic: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: Date.now(),
			};
			result.push(synthetic);
		}
		pending = [];
		answered = new Set();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			closePending();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const converted = convertForModel(message, model);
			pending = converted.content.filter((block) => block.type === "toolCall");
			result.push(converted);
		} else if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			result.push(message);
		} else {
			// 新的用户消息打断了工具流程。
			closePending();
			result.push(message);
		}
	}
	closePending();
	return result;
}

function convertForModel(message: AssistantMessage, model: Model): AssistantMessage {
	const sameModel = message.provider === model.provider && message.model === model.id;
	if (sameModel) return message;
	return {
		...message,
		content: message.content.filter((block) => block.type !== "thinking"),
	};
}
