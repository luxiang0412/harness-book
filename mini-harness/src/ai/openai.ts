/**
 * 第 1 章：OpenAI Chat Completions (以及兼容接口) 适配器。
 *
 * 对应 pi 的 packages/ai/src/api/openai-completions.ts。
 * DeepSeek、Ollama、vLLM、OpenRouter 等大多兼容这个接口，所以它的覆盖面最广。
 *
 * 和 Anthropic 的主要差异：
 * - 有独立的 "tool" 角色承载工具结果；
 * - 流里没有"内容块开始/结束"事件，只有增量 delta，块边界要自己推断；
 * - tool call 参数以字符串片段到达，按 index 归属到不同的调用。
 */

import { AssistantMessageEventStream } from "./event-stream.ts";
import { iterateSse, parseToolArguments } from "./sse.ts";
import { transformMessages } from "./transform.ts";
import {
	type AssistantMessage,
	type Context,
	contentText,
	createAssistantMessage,
	type Message,
	type Model,
	type StopReason,
	type StreamOptions,
	type ToolCall,
} from "./types.ts";

export function streamOpenAI(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);

	(async () => {
		try {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
			const response = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(buildRequest(model, context, options)),
				signal: options.signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(`${response.status} ${await response.text()}`);
			}
			stream.push({ type: "start", partial: output });
			await consumeChunks(response.body, output, stream, options.signal);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error("Provider stopped with an error (e.g. content filter)");
			stream.push({ type: "done", message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", error: output });
		}
	})();

	return stream;
}

function buildRequest(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
	const messages: Record<string, unknown>[] = [];
	if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
	messages.push(...convertMessages(transformMessages(context.messages, model)));

	const request: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: options.maxTokens ?? model.maxTokens,
	};
	if (context.tools && context.tools.length > 0) {
		request.tools = context.tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}
	if (options.temperature !== undefined) request.temperature = options.temperature;
	return request;
}

function convertMessages(messages: Message[]): Record<string, unknown>[] {
	return messages.map((message) => {
		if (message.role === "user") {
			if (typeof message.content === "string") return { role: "user", content: message.content };
			return {
				role: "user",
				content: message.content.map((block) =>
					block.type === "text"
						? { type: "text", text: block.text }
						: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
				),
			};
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const toolCalls = message.content
				.filter((block) => block.type === "toolCall")
				.map((call) => ({
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				}));
			return {
				role: "assistant",
				content: text || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			};
		}
		// Chat Completions 的 tool 消息只接受文本，图片结果在这里降级为文字。
		return { role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) || "(empty)" };
	});
}

type StreamingToolCall = ToolCall & { partialJson: string };

async function consumeChunks(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal: AbortSignal | undefined,
): Promise<void> {
	// 当前正在增长的块。新类型的 delta 到来时，先结束旧块。
	let current: { kind: "text" | "thinking" | "toolCall"; contentIndex: number; toolIndex?: number } | undefined;

	const finishCurrent = () => {
		if (!current) return;
		const { contentIndex } = current;
		const block = output.content[contentIndex];
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
		} else {
			const call = block as StreamingToolCall;
			Object.assign(call, parseToolArguments(call.partialJson));
			const { partialJson: _partialJson, ...finalCall } = call;
			output.content[contentIndex] = finalCall;
			stream.push({ type: "toolcall_end", contentIndex, toolCall: finalCall, partial: output });
		}
		current = undefined;
	};

	for await (const sse of iterateSse(body, signal)) {
		if (sse.data === "[DONE]") break;
		const chunk = JSON.parse(sse.data) as Record<string, any>;

		if (chunk.usage) {
			const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
			output.usage.input = (chunk.usage.prompt_tokens ?? 0) - cached;
			output.usage.cacheRead = cached;
			output.usage.output = chunk.usage.completion_tokens ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.cacheRead + output.usage.output;
		}

		const choice = chunk.choices?.[0];
		if (!choice) continue;
		const delta = choice.delta ?? {};

		// DeepSeek 等把推理过程放在 reasoning_content 字段里。
		const reasoning: string | undefined = delta.reasoning_content ?? delta.reasoning;
		if (reasoning) {
			if (current?.kind !== "thinking") {
				finishCurrent();
				current = { kind: "thinking", contentIndex: output.content.length };
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex: current.contentIndex, partial: output });
			}
			const block = output.content[current.contentIndex];
			if (block.type === "thinking") block.thinking += reasoning;
			stream.push({ type: "thinking_delta", contentIndex: current.contentIndex, delta: reasoning, partial: output });
		}

		if (delta.content) {
			if (current?.kind !== "text") {
				finishCurrent();
				current = { kind: "text", contentIndex: output.content.length };
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: current.contentIndex, partial: output });
			}
			const block = output.content[current.contentIndex];
			if (block.type === "text") block.text += delta.content;
			stream.push({ type: "text_delta", contentIndex: current.contentIndex, delta: delta.content, partial: output });
		}

		for (const toolDelta of delta.tool_calls ?? []) {
			if (current?.kind !== "toolCall" || current.toolIndex !== toolDelta.index) {
				finishCurrent();
				current = { kind: "toolCall", contentIndex: output.content.length, toolIndex: toolDelta.index };
				const call: StreamingToolCall = {
					type: "toolCall",
					id: toolDelta.id ?? `call_${Date.now()}_${toolDelta.index}`,
					name: toolDelta.function?.name ?? "",
					arguments: {},
					partialJson: "",
				};
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex: current.contentIndex, partial: output });
			}
			const call = output.content[current.contentIndex] as StreamingToolCall;
			if (toolDelta.function?.name && !call.name) call.name = toolDelta.function.name;
			const fragment: string = toolDelta.function?.arguments ?? "";
			if (fragment) {
				call.partialJson += fragment;
				stream.push({ type: "toolcall_delta", contentIndex: current.contentIndex, delta: fragment, partial: output });
			}
		}

		if (choice.finish_reason) output.stopReason = mapFinishReason(choice.finish_reason);
	}
	finishCurrent();
	// 有些兼容服务不返回 finish_reason="tool_calls"，按内容推断。
	if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall")) {
		output.stopReason = "toolUse";
	}
}

function mapFinishReason(reason: string): StopReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		default:
			return "error";
	}
}
