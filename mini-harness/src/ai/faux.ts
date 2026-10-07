/**
 * 第 1 章 / 第 18 章：脚本化的假模型。
 *
 * 对应 pi 的 packages/ai/src/providers/faux.ts。
 *
 * 它按预先写好的剧本回复，同时完整走一遍流式事件协议。
 * 用途：
 * - 没有 API key 也能运行和调试 harness；
 * - 测试里得到确定的模型行为 (第 18 章)。
 *
 *   const faux = createFauxModel([
 *     [toolCall("read", { path: "a.txt" })],   // 第 1 次请求：调用工具
 *     "文件内容是 hello",                        // 第 2 次请求：给出答案
 *   ]);
 */

import { AssistantMessageEventStream } from "./event-stream.ts";
import {
	type AssistantMessage,
	type Context,
	contentText,
	createAssistantMessage,
	type Model,
	type StreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "./types.ts";

export type FauxBlock = TextContent | ThinkingContent | ToolCall;
/** 剧本里的一步：固定内容，或者根据请求上下文动态生成内容。 */
export type FauxStep = string | FauxBlock[] | ((context: Context) => string | FauxBlock[]);

let nextId = 0;

export function text(value: string): TextContent {
	return { type: "text", text: value };
}

export function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	nextId += 1;
	return { type: "toolCall", id: `faux_${nextId}`, name, arguments: args };
}

export interface FauxModel {
	model: Model;
	/** 每次请求收到的上下文，测试里可以检查 harness 实际发了什么。 */
	requests: Context[];
	/** 剩余未消费的剧本步数。 */
	remaining(): number;
}

const registry = new Map<string, { steps: FauxStep[]; requests: Context[] }>();

export function createFauxModel(steps: FauxStep[], options: { id?: string; contextWindow?: number } = {}): FauxModel {
	const id = options.id ?? `faux-${registry.size + 1}`;
	const state = { steps: [...steps], requests: [] as Context[] };
	registry.set(id, state);
	return {
		model: {
			id,
			name: "Faux",
			api: "faux",
			provider: "faux",
			baseUrl: "",
			contextWindow: options.contextWindow ?? 128_000,
			maxTokens: 8_000,
			reasoning: false,
		},
		requests: state.requests,
		remaining: () => state.steps.length,
	};
}

export function streamFaux(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);

	(async () => {
		const state = registry.get(model.id);
		try {
			if (!state) throw new Error(`Unknown faux model ${model.id}`);
			state.requests.push(structuredClone(context));
			const step = state.steps.shift();
			if (step === undefined) throw new Error("Faux script exhausted");
			const raw = typeof step === "function" ? step(context) : step;
			const blocks: FauxBlock[] = typeof raw === "string" ? [text(raw)] : raw;

			// 粗略估算 token：4 个字符约等于 1 个 token。
			const inputChars = JSON.stringify(context).length;
			output.usage.input = Math.ceil(inputChars / 4);

			stream.push({ type: "start", partial: output });
			for (const block of blocks) {
				await emitBlock(block, output, stream, options.signal);
			}
			output.usage.output = Math.ceil(JSON.stringify(output.content).length / 4);
			output.usage.totalTokens = output.usage.input + output.usage.output;
			output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			stream.push({ type: "done", message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", error: output });
		}
	})();

	return stream;
}

async function emitBlock(
	block: FauxBlock,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal: AbortSignal | undefined,
): Promise<void> {
	const contentIndex = output.content.length;
	if (block.type === "toolCall") {
		output.content.push({ ...block });
		stream.push({ type: "toolcall_start", contentIndex, partial: output });
		stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		return;
	}
	const value = block.type === "text" ? block.text : block.thinking;
	if (block.type === "text") {
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex, partial: output });
	} else {
		output.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex, partial: output });
	}
	// 按小块吐出，模拟真实的流式输出。
	for (let i = 0; i < value.length; i += 4) {
		await new Promise((resolve) => setImmediate(resolve));
		if (signal?.aborted) throw new Error("Request was aborted");
		const delta = value.slice(i, i + 4);
		const target = output.content[contentIndex];
		if (target.type === "text") {
			target.text += delta;
			stream.push({ type: "text_delta", contentIndex, delta, partial: output });
		} else if (target.type === "thinking") {
			target.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
		}
	}
	const target = output.content[contentIndex];
	if (target.type === "text") stream.push({ type: "text_end", contentIndex, content: target.text, partial: output });
	else if (target.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex, content: target.thinking, partial: output });
	}
}

/** 方便测试：取出最近一次请求里最后一条用户消息的文本。 */
export function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "user") return contentText(message.content);
	}
	return "";
}
