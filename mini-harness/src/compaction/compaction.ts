/**
 * 第 7 章：上下文压缩。
 *
 * 对应 pi 的 packages/coding-agent/src/core/compaction/compaction.ts。
 *
 * 触发条件：contextTokens > contextWindow - reserveTokens
 * (reserveTokens 给模型的回复留空间，默认 16384)。
 *
 * 做法：
 * 1. 从最新的消息往前累加 token，直到达到 keepRecentTokens (默认 20000)，确定切点；
 * 2. 切点之前的消息交给模型，生成结构化摘要；
 * 3. 追加一条 compaction entry：{ summary, firstKeptEntryId }；
 * 4. 之后重建上下文时，切点之前的历史被摘要替代。
 *
 * 切点只能落在 user 或 assistant 消息上，不能落在 toolResult 上：
 * tool result 必须紧跟着发起它的 tool call，否则 API 会拒绝。
 */

import type { AgentMessage } from "../agent/types.ts";
import { convertToLlm } from "../agent/messages.ts";
import type { StreamFn } from "../ai/stream.ts";
import { contentText, type Message, type Model, type Usage } from "../ai/types.ts";
import type { CompactionEntry, SessionEntry, SessionManager } from "../session/session-manager.ts";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

// ---------- token 估算 ----------

/** 粗估：4 个字符约 1 个 token。偏保守，宁可早压缩也不要溢出。 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user":
			chars = typeof message.content === "string" ? message.content.length : contentText(message.content).length;
			if (Array.isArray(message.content)) chars += message.content.filter((block) => block.type === "image").length * 4800;
			break;
		case "assistant":
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			break;
		case "toolResult":
			chars = contentText(message.content).length;
			break;
		case "summary":
			chars = message.summary.length;
			break;
		case "custom":
			chars = message.content.length;
			break;
	}
	return Math.ceil(chars / 4);
}

function usageTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 估算当前上下文大小。
 * 最准确的数字是上一次 assistant 回复的 usage (provider 实际计数的 token)，
 * 它之后新增的消息 (工具结果等) 再用字符数估算补上。
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			const counted = usageTokens(message.usage);
			if (counted > 0) {
				let trailing = 0;
				for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens(messages[j]);
				return counted + trailing;
			}
		}
	}
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}

// ---------- 切点 ----------

function isValidCutPoint(entry: SessionEntry): boolean {
	return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

export interface CompactionPreparation {
	/** 要被摘要的消息。 */
	toSummarize: AgentMessage[];
	firstKeptEntryId: string;
	previousSummary?: string;
	tokensBefore: number;
}

/**
 * 在当前分支上找切点。如果之前压缩过，从上一次保留的边界开始算：
 * 上次被保留下来的消息这次可能需要被摘要。
 */
export function prepareCompaction(session: SessionManager, settings: CompactionSettings): CompactionPreparation | undefined {
	const path = session.getPath();
	let start = 0;
	let previous: CompactionEntry | undefined;
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type === "compaction") {
			previous = entry;
			const keptIndex = path.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			start = keptIndex >= 0 ? keptIndex : i + 1;
			break;
		}
	}

	// 从最新往前累加，直到达到 keepRecentTokens。
	let accumulated = 0;
	let cutIndex = -1;
	for (let i = path.length - 1; i >= start; i--) {
		const entry = path[i];
		if (entry.type !== "message") continue;
		accumulated += estimateTokens(entry.message);
		if (accumulated >= settings.keepRecentTokens) {
			// 从当前位置往后找最近的合法切点。
			for (let j = i; j < path.length; j++) {
				if (isValidCutPoint(path[j])) {
					cutIndex = j;
					break;
				}
			}
			break;
		}
	}
	if (cutIndex <= start) return undefined; // 没有足够的旧消息可以压缩

	const toSummarize = path
		.slice(start, cutIndex)
		.filter((entry) => entry.type === "message" && entry.message.role !== "summary")
		.map((entry) => (entry as Extract<SessionEntry, { type: "message" }>).message);
	if (toSummarize.length === 0) return undefined;

	return {
		toSummarize,
		firstKeptEntryId: path[cutIndex].id,
		previousSummary: previous?.summary,
		tokensBefore: estimateContextTokens(session.buildContext().messages),
	};
}

// ---------- 生成摘要 ----------

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- PRESERVE exact file paths, function names, and error messages

Use the same format as the previous summary.`;

/**
 * 把对话序列化成纯文本。
 * 如果直接把消息原样发过去，模型会以为自己在对话里，接着回答最后一个问题，而不是做摘要。
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			parts.push(`[User]: ${contentText(message.content)}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") parts.push(`[Assistant]: ${block.text}`);
				else if (block.type === "toolCall") parts.push(`[Assistant tool call]: ${block.name}(${JSON.stringify(block.arguments)})`);
			}
		} else {
			// 工具结果可能很长，摘要时只保留开头。
			const text = contentText(message.content);
			parts.push(`[Tool result${message.isError ? " (error)" : ""}]: ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`);
		}
	}
	return parts.join("\n\n");
}

export async function generateSummary(
	messages: AgentMessage[],
	model: Model,
	streamFn: StreamFn,
	options: { apiKey?: string; previousSummary?: string; customInstructions?: string; signal?: AbortSignal } = {},
): Promise<string> {
	let prompt = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n`;
	if (options.previousSummary) prompt += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
	prompt += options.previousSummary ? UPDATE_PROMPT : SUMMARIZATION_PROMPT;
	if (options.customInstructions) prompt += `\n\nAdditional focus: ${options.customInstructions}`;

	const response = await streamFn(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		{ apiKey: options.apiKey, signal: options.signal, maxTokens: Math.min(8_000, model.maxTokens) },
	).result();

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`Summarization failed: ${response.errorMessage ?? response.stopReason}`);
	}
	// 被截断的摘要不完整，不能作为检查点保存。
	if (response.stopReason === "length") throw new Error("Summarization hit the token limit; summary is incomplete");
	return contentText(response.content.filter((block) => block.type === "text"));
}

/** 完整的压缩流程：准备 → 摘要 → 写入会话。返回 undefined 表示没什么可压缩的。 */
export async function compact(
	session: SessionManager,
	model: Model,
	streamFn: StreamFn,
	options: { settings?: CompactionSettings; apiKey?: string; customInstructions?: string; signal?: AbortSignal } = {},
): Promise<{ summary: string; tokensBefore: number } | undefined> {
	const preparation = prepareCompaction(session, options.settings ?? DEFAULT_COMPACTION_SETTINGS);
	if (!preparation) return undefined;
	const summary = await generateSummary(preparation.toSummarize, model, streamFn, {
		apiKey: options.apiKey,
		previousSummary: preparation.previousSummary,
		customInstructions: options.customInstructions,
		signal: options.signal,
	});
	session.appendCompaction(summary, preparation.firstKeptEntryId, preparation.tokensBefore);
	return { summary, tokensBefore: preparation.tokensBefore };
}
