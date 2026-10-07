/**
 * 第 2 章 / 第 7 章：AgentMessage → Message。
 *
 * 对应 pi 的 packages/coding-agent/src/core/messages.ts 中的 convertToLlm()。
 * 摘要和扩展消息对模型来说都是 "user 说的话"，用固定的前后缀包起来，
 * 让模型知道这段内容的来历。
 */

import type { Message } from "../ai/types.ts";
import type { AgentMessage } from "./types.ts";

export const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const SUMMARY_SUFFIX = "\n</summary>";

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		switch (message.role) {
			case "user":
			case "assistant":
			case "toolResult":
				return [message];
			case "summary": {
				const prefix = message.kind === "compaction" ? COMPACTION_SUMMARY_PREFIX : BRANCH_SUMMARY_PREFIX;
				return [{ role: "user", content: prefix + message.summary + SUMMARY_SUFFIX, timestamp: message.timestamp }];
			}
			case "custom":
				return [{ role: "user", content: message.content, timestamp: message.timestamp }];
		}
	});
}
