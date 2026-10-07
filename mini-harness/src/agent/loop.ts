/**
 * 第 2 章：agent loop。
 *
 * 对应 pi 的 packages/agent/src/agent-loop.ts。结构几乎一致：
 *
 *   外层循环：agent 本来要停下时，检查 follow-up 消息
 *     内层循环：只要还有 tool call 或插话消息就继续
 *       1. 注入待处理消息 (steering / follow-up)
 *       2. 请求模型，流式接收回复
 *       3. 执行回复里的 tool call，结果追加到上下文
 *       4. 检查 steering 消息
 *
 * 整个 loop 只通过 emit() 向外报告进展，不直接碰 UI 或磁盘。
 */

import type { AssistantMessage, Context, Tool, ToolCall, ToolResultMessage } from "../ai/types.ts";
import type {
	AgentContext,
	AgentEventSink,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	BeforeToolCallResult,
} from "./types.ts";
import { validateArguments } from "./validate.ts";

/** 以新消息开始一次 run。返回本次 run 新产生的消息。 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const current: AgentContext = { ...context, messages: [...context.messages, ...prompts] };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of prompts) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}
	await runLoop(current, newMessages, config, emit, signal);
	return newMessages;
}

/**
 * 不加新消息，从现有上下文继续 (用于重试)。
 * 最后一条消息必须是 user 或 toolResult，否则模型没有可回应的内容。
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	const last = context.messages.at(-1);
	if (!last || last.role === "assistant") throw new Error("Cannot continue: last message must not be an assistant message");
	const newMessages: AgentMessage[] = [];
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	await runLoop({ ...context, messages: [...context.messages] }, newMessages, config, emit, signal);
	return newMessages;
}

async function runLoop(
	context: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<void> {
	let config = initialConfig;
	let firstTurn = true;
	// 用户可能在等待期间就输入了插话。
	let pending: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

	while (true) {
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pending.length > 0) {
			if (!firstTurn) {
				// turn 之间的钩子：压缩 (第 7 章)、刷新 system prompt (第 5 章) 都在这里。
				const update = await config.prepareNextTurn?.(context);
				if (update) {
					if (update.messages) context.messages = update.messages;
					if (update.systemPrompt !== undefined) context.systemPrompt = update.systemPrompt;
					if (update.tools) context.tools = update.tools;
					if (update.model) config = { ...config, model: update.model };
				}
				await emit({ type: "turn_start" });
			}
			firstTurn = false;

			for (const message of pending) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				context.messages.push(message);
				newMessages.push(message);
			}
			pending = [];

			const message = await streamAssistantResponse(context, config, emit, signal);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// stopReason 为 length 说明输出被截断，tool call 的参数可能不完整，一律不执行。
				const batch =
					message.stopReason === "length"
						? await failTruncatedToolCalls(toolCalls, emit)
						: await executeToolCalls(context, toolCalls, config, emit, signal);
				toolResults.push(...batch.messages);
				hasMoreToolCalls = !batch.terminate;
				for (const result of toolResults) {
					context.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			pending = (await config.getSteeringMessages?.()) ?? [];
		}

		// agent 本来要停了。有没有排队的 follow-up？
		const followUps = (await config.getFollowUpMessages?.()) ?? [];
		if (followUps.length > 0) {
			pending = followUps;
			continue;
		}
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/** 工具声明只包含模型需要知道的部分。 */
export function toToolDeclaration(tool: AgentTool): Tool {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/**
 * 请求模型并把流式事件转发出去。
 * 这是 AgentMessage[] 转换成 Message[] 的唯一位置。
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) messages = await config.transformContext(messages, signal);

	const request: Context = {
		systemPrompt: context.systemPrompt,
		messages: config.convertToLlm(messages),
		tools: context.tools.map(toToolDeclaration),
	};
	const apiKey = await config.getApiKey?.(config.model.provider);
	const response = config.streamFn(config.model, request, {
		apiKey,
		signal,
		maxTokens: config.maxTokens,
		sessionId: config.sessionId,
	});

	let added = false;
	for await (const event of response) {
		if (event.type === "start") {
			// partial 先放进上下文，UI 在流式过程中就能读到它。
			context.messages.push(event.partial);
			added = true;
			await emit({ type: "message_start", message: { ...event.partial } });
		} else if (event.type === "done" || event.type === "error") {
			break;
		} else if (added) {
			context.messages[context.messages.length - 1] = event.partial;
			await emit({ type: "message_update", message: { ...event.partial }, event });
		}
	}

	const final = await response.result();
	if (added) {
		context.messages[context.messages.length - 1] = final;
	} else {
		// 请求在 start 之前就失败了 (例如没有 API key)。
		context.messages.push(final);
		await emit({ type: "message_start", message: { ...final } });
	}
	await emit({ type: "message_end", message: final });
	return final;
}

// ---------- 工具执行 ----------

interface ToolBatch {
	messages: ToolResultMessage[];
	terminate: boolean;
}

interface Outcome {
	toolCall: ToolCall;
	result: AgentToolResult;
	isError: boolean;
}

type Prepared =
	| { kind: "ready"; toolCall: ToolCall; tool: AgentTool; args: Record<string, unknown> }
	| { kind: "immediate"; outcome: Outcome };

function errorResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

async function failTruncatedToolCalls(toolCalls: ToolCall[], emit: AgentEventSink): Promise<ToolBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
		const outcome: Outcome = {
			toolCall,
			result: errorResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		messages.push(await finishOutcome(outcome, emit));
	}
	return { messages, terminate: false };
}

async function executeToolCalls(
	context: AgentContext,
	toolCalls: ToolCall[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<ToolBatch> {
	const sequential =
		config.toolExecution === "sequential" ||
		toolCalls.some((call) => context.tools.find((tool) => tool.name === call.name)?.executionMode === "sequential");

	if (sequential) {
		const outcomes: Outcome[] = [];
		const messages: ToolResultMessage[] = [];
		for (const toolCall of toolCalls) {
			await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
			const prepared = await prepareToolCall(context, toolCall, config, signal);
			const outcome = prepared.kind === "immediate" ? prepared.outcome : await runPrepared(prepared, context, config, emit, signal);
			outcomes.push(outcome);
			messages.push(await finishOutcome(outcome, emit));
			if (signal?.aborted) break;
		}
		return { messages, terminate: shouldTerminate(outcomes) };
	}

	// 并行模式：先按顺序做准备 (查找、校验、beforeToolCall)，
	// 再并发执行。结果消息仍按 tool call 原来的顺序追加，保证历史稳定。
	const tasks: (() => Promise<Outcome>)[] = [];
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
		const prepared = await prepareToolCall(context, toolCall, config, signal);
		if (prepared.kind === "immediate") {
			await emit(executionEnd(prepared.outcome));
			tasks.push(async () => prepared.outcome);
			continue;
		}
		tasks.push(async () => {
			const outcome = await runPrepared(prepared, context, config, emit, signal);
			await emit(executionEnd(outcome));
			return outcome;
		});
	}
	const outcomes = await Promise.all(tasks.map((task) => task()));
	const messages: ToolResultMessage[] = [];
	for (const outcome of outcomes) {
		const message = toResultMessage(outcome);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		messages.push(message);
	}
	return { messages, terminate: shouldTerminate(outcomes) };
}

function shouldTerminate(outcomes: Outcome[]): boolean {
	return outcomes.length > 0 && outcomes.every((outcome) => outcome.result.terminate === true);
}

/** 查找工具、校验参数、运行 beforeToolCall 钩子。任何一步失败都直接得到错误结果。 */
async function prepareToolCall(
	context: AgentContext,
	toolCall: ToolCall,
	config: Pick<AgentLoopConfig, "beforeToolCall">,
	signal: AbortSignal | undefined,
): Promise<Prepared> {
	const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) return immediate(toolCall, `Tool ${toolCall.name} not found`);

	const errors = validateArguments(tool.parameters, toolCall.arguments);
	if (errors.length > 0) {
		return immediate(toolCall, `Invalid arguments for ${toolCall.name}:\n${errors.join("\n")}`);
	}

	let before: BeforeToolCallResult | undefined;
	try {
		before = await config.beforeToolCall?.({ toolCall, args: toolCall.arguments, context }, signal);
	} catch (error) {
		// 钩子出错时阻止执行 (fail closed)：权限检查失败不能等于放行。
		return immediate(toolCall, `Tool call blocked: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (signal?.aborted) return immediate(toolCall, "Operation aborted");
	if (before?.block) return immediate(toolCall, before.reason ?? "Tool execution was blocked");
	return { kind: "ready", toolCall, tool, args: toolCall.arguments };
}

function immediate(toolCall: ToolCall, message: string): Prepared {
	return { kind: "immediate", outcome: { toolCall, result: errorResult(message), isError: true } };
}

/** 执行工具并运行 afterToolCall 钩子。工具抛出的异常变成错误结果，永远不会让 loop 崩溃。 */
async function runPrepared(
	prepared: Extract<Prepared, { kind: "ready" }>,
	context: AgentContext,
	config: Pick<AgentLoopConfig, "afterToolCall">,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<Outcome> {
	const { toolCall, tool, args } = prepared;
	let result: AgentToolResult;
	let isError: boolean;
	try {
		result = await tool.execute(toolCall.id, args, signal, (partialResult) => {
			void emit({ type: "tool_execution_update", toolCallId: toolCall.id, toolName: toolCall.name, partialResult });
		});
		isError = result.isError === true;
	} catch (error) {
		result = errorResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}

	if (config.afterToolCall) {
		try {
			const override = await config.afterToolCall({ toolCall, args, result, isError, context }, signal);
			if (override) {
				result = { ...result, ...override };
				isError = override.isError ?? isError;
			}
		} catch (error) {
			result = errorResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}
	return { toolCall, result, isError };
}

/**
 * 不经过 loop、单独执行一个 tool call，但同样经过校验和钩子。
 * 第 17 章 code mode 里，脚本调用工具就走这里，权限检查因此也对它生效。
 */
export async function runToolCall(
	toolCall: ToolCall,
	context: AgentContext,
	config: Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">,
	signal?: AbortSignal,
): Promise<{ result: AgentToolResult; isError: boolean }> {
	const prepared = await prepareToolCall(context, toolCall, config, signal);
	if (prepared.kind === "immediate") return prepared.outcome;
	return runPrepared(prepared, context, config, () => {}, signal);
}

function executionEnd(outcome: Outcome) {
	return {
		type: "tool_execution_end" as const,
		toolCallId: outcome.toolCall.id,
		toolName: outcome.toolCall.name,
		result: outcome.result,
		isError: outcome.isError,
	};
}

async function finishOutcome(outcome: Outcome, emit: AgentEventSink): Promise<ToolResultMessage> {
	await emit(executionEnd(outcome));
	const message = toResultMessage(outcome);
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

function toResultMessage(outcome: Outcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: outcome.toolCall.id,
		toolName: outcome.toolCall.name,
		content: outcome.result.content ?? [],
		isError: outcome.isError,
		timestamp: Date.now(),
	};
}
