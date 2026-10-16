/**
 * 第 1 章：Anthropic Messages API 适配器。
 *
 * 对应 pi 的 packages/ai/src/api/anthropic-messages.ts (约 1600 行)。
 * 这里保留骨架：请求转换 → SSE 解析 → 统一事件。
 *
 * 适配器的约定 (和 pi 相同)：
 * - 永远返回事件流，不抛异常；失败编码为 error 事件 + stopReason "error"/"aborted"。
 * - 每个事件都带上当前拼好的 partial 消息。
 */

import { AssistantMessageEventStream } from "./event-stream.ts";
import { iterateSse, parseToolArguments } from "./sse.ts";
import { transformMessages } from "./transform.ts";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessage,
	type ImageContent,
	type Message,
	type Model,
	type StopReason,
	type StreamOptions,
	type TextContent,
	type ToolCall,
} from "./types.ts";

type AnthropicBlock = Record<string, unknown>;
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

const CACHE_CONTROL = { type: "ephemeral" };

export function streamAnthropic(model: Model, context: Context, options: StreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);

	(async () => {
		try {
			if (!options.apiKey) throw new Error("No API key for provider anthropic (set ANTHROPIC_API_KEY)");
			const response = await fetch(`${model.baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": options.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(buildRequest(model, context, options)),
				signal: options.signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(`${response.status} ${await response.text()}`);
			}
			stream.push({ type: "start", partial: output });
			await consumeEvents(response.body, output, stream, options.signal);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error("Provider stopped with an error (e.g. refusal)");
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
	const messages = convertMessages(transformMessages(context.messages, model));
	// prompt cache 断点：把缓存标记放在最后一条消息的最后一个块上，
	// 下一轮请求时，整个前缀 (system + tools + 历史) 都能命中缓存。
	const last = messages.at(-1)?.content.at(-1);
	if (last) last.cache_control = CACHE_CONTROL;

	const request: Record<string, unknown> = {
		model: model.id,
		max_tokens: options.maxTokens ?? model.maxTokens,
		stream: true,
		messages,
	};
	if (context.systemPrompt) {
		request.system = [{ type: "text", text: context.systemPrompt, cache_control: CACHE_CONTROL }];
	}
	if (context.tools && context.tools.length > 0) {
		request.tools = context.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}
	if (options.temperature !== undefined) request.temperature = options.temperature;
	return request;
}

function convertContent(content: string | (TextContent | ImageContent)[]): AnthropicBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.flatMap((block): AnthropicBlock[] => {
		if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
		return [{ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }];
	});
}

/**
 * 统一消息 → Anthropic 消息。
 * 关键差异：Anthropic 没有 "tool" 角色，工具结果是 user 消息里的 tool_result 块，
 * 而且连续的多个工具结果必须合并进同一条 user 消息。
 */
function convertMessages(messages: Message[]): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const content = convertContent(message.content);
			if (content.length > 0) result.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const content = message.content.flatMap((block): AnthropicBlock[] => {
				if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
				if (block.type === "thinking") {
					return block.signature ? [{ type: "thinking", thinking: block.thinking, signature: block.signature }] : [];
				}
				return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
			});
			if (content.length > 0) result.push({ role: "assistant", content });
		} else {
			const toolResult: AnthropicBlock = {
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: convertContent(message.content),
				is_error: message.isError,
			};
			const previous = result.at(-1);
			if (previous?.role === "user" && previous.content.every((block) => block.type === "tool_result")) {
				previous.content.push(toolResult);
			} else {
				result.push({ role: "user", content: [toolResult] });
			}
		}
	}
	return result;
}

type StreamingToolCall = ToolCall & { partialJson: string };

async function consumeEvents(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal: AbortSignal | undefined,
): Promise<void> {
	// Anthropic 用 index 标识内容块，这里记录 index → output.content 下标。
	const blockIndex = new Map<number, number>();

	for await (const sse of iterateSse(body, signal)) {
		const event = JSON.parse(sse.data) as Record<string, any>;
		switch (event.type) {
			case "message_start": {
				const usage = event.message.usage ?? {};
				output.usage.input = usage.input_tokens ?? 0;
				output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
				break;
			}
			case "content_block_start": {
				const block = event.content_block;
				const contentIndex = output.content.length;
				blockIndex.set(event.index, contentIndex);
				if (block.type === "text") {
					output.content.push({ type: "text", text: block.text ?? "" });
					stream.push({ type: "text_start", contentIndex, partial: output });
				} else if (block.type === "thinking") {
					output.content.push({ type: "thinking", thinking: block.thinking ?? "", signature: "" });
					stream.push({ type: "thinking_start", contentIndex, partial: output });
				} else if (block.type === "tool_use") {
					const call: StreamingToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {}, partialJson: "" };
					output.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
				} else {
					blockIndex.delete(event.index); // redacted_thinking 等，本书不处理
				}
				break;
			}
			case "content_block_delta": {
				const contentIndex = blockIndex.get(event.index);
				if (contentIndex === undefined) break;
				const block = output.content[contentIndex];
				const delta = event.delta;
				if (delta.type === "text_delta" && block.type === "text") {
					block.text += delta.text;
					stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
				} else if (delta.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += delta.thinking;
					stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
				} else if (delta.type === "signature_delta" && block.type === "thinking") {
					block.signature = (block.signature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
					const call = block as StreamingToolCall;
					call.partialJson += delta.partial_json;
					stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
				}
				break;
			}
			case "content_block_stop": {
				const contentIndex = blockIndex.get(event.index);
				if (contentIndex === undefined) break;
				const block = output.content[contentIndex];
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else {
					const call = block as StreamingToolCall;
					Object.assign(call, parseToolArguments(call.partialJson));
					// partialJson 只是流式缓冲区，不能进入会话历史。
					const { partialJson: _partialJson, ...finalCall } = call;
					output.content[contentIndex] = finalCall;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: finalCall, partial: output });
				}
				break;
			}
			case "message_delta": {
				if (event.delta?.stop_reason) output.stopReason = mapStopReason(event.delta.stop_reason);
				if (event.usage?.output_tokens != null) output.usage.output = event.usage.output_tokens;
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				break;
			}
			case "error":
				throw new Error(event.error?.message ?? "Anthropic stream error");
		}
	}
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			// refusal 等：当作错误交给上层处理
			return "error";
	}
}
