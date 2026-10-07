/**
 * 第 4 章：有状态的 Agent。
 *
 * 对应 pi 的 packages/agent/src/agent.ts。
 *
 * loop 是无状态的函数：给它上下文，它产生事件。
 * Agent 把 loop 包装成一个对象，负责：
 * - 持有对话状态 (消息、工具、模型)；
 * - 把 loop 的事件转发给订阅者 (UI、会话持久化、扩展)；
 * - 中断 (abort)、插话 (steer)、追加任务 (followUp)；
 * - 保证同一时间只有一个 run。
 */

import { type StreamFn, stream as defaultStream } from "../ai/stream.ts";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "../ai/types.ts";
import { runAgentLoop, runAgentLoopContinue } from "./loop.ts";
import { convertToLlm as defaultConvertToLlm } from "./messages.ts";
import type {
	AfterToolCallContext,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	TurnUpdate,
} from "./types.ts";

export interface AgentState {
	systemPrompt: string;
	model: Model;
	tools: AgentTool[];
	messages: AgentMessage[];
	isRunning: boolean;
	/** 正在流式生成的 assistant 消息，UI 用它渲染"打字中"的内容。 */
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
}

export interface AgentOptions {
	model: Model;
	systemPrompt?: string;
	tools?: AgentTool[];
	messages?: AgentMessage[];
	streamFn?: StreamFn;
	convertToLlm?: (messages: AgentMessage[]) => Message[];
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<Partial<AgentToolResult> | undefined>;
	prepareNextTurn?: (context: AgentContext) => Promise<TurnUpdate | undefined>;
	toolExecution?: "sequential" | "parallel";
	sessionId?: string;
}

export type AgentListener = (event: AgentEvent) => void | Promise<void>;

export class Agent {
	readonly state: AgentState;
	private readonly listeners = new Set<AgentListener>();
	private readonly steeringQueue: AgentMessage[] = [];
	private readonly followUpQueue: AgentMessage[] = [];
	private abortController?: AbortController;
	private runPromise?: Promise<void>;

	streamFn: StreamFn;
	convertToLlm: (messages: AgentMessage[]) => Message[];
	transformContext?: AgentOptions["transformContext"];
	getApiKey?: AgentOptions["getApiKey"];
	beforeToolCall?: AgentOptions["beforeToolCall"];
	afterToolCall?: AgentOptions["afterToolCall"];
	prepareNextTurn?: AgentOptions["prepareNextTurn"];
	toolExecution: "sequential" | "parallel";
	sessionId?: string;

	constructor(options: AgentOptions) {
		this.state = {
			systemPrompt: options.systemPrompt ?? "",
			model: options.model,
			tools: options.tools ?? [],
			messages: options.messages ?? [],
			isRunning: false,
			pendingToolCalls: new Set(),
		};
		this.streamFn = options.streamFn ?? defaultStream;
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.getApiKey = options.getApiKey;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.sessionId = options.sessionId;
	}

	/** 订阅事件。监听器按订阅顺序依次 await，慢监听器会拖慢 loop (这是有意的背压)。 */
	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 开始一次新的 run。已经在运行时不能再 prompt，应改用 steer() 或 followUp()。 */
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.state.isRunning) {
			throw new Error("Agent is already running. Use steer() or followUp() to queue messages.");
		}
		const messages = this.normalize(input, images);
		await this.run((signal) => runAgentLoop(messages, this.snapshot(), this.loopConfig(), (event) => this.handle(event), signal));
	}

	/** 从当前历史继续，用于失败后的重试。 */
	async continue(): Promise<void> {
		if (this.state.isRunning) throw new Error("Agent is already running.");
		await this.run((signal) => runAgentLoopContinue(this.snapshot(), this.loopConfig(), (event) => this.handle(event), signal));
	}

	/** 插话：当前 turn 的工具执行完后、下一次请求模型前注入。 */
	steer(message: AgentMessage | string): void {
		this.steeringQueue.push(typeof message === "string" ? userMessage(message) : message);
	}

	/** 追加任务：等 agent 把手头工作做完、本来要停下时再注入。 */
	followUp(message: AgentMessage | string): void {
		this.followUpQueue.push(typeof message === "string" ? userMessage(message) : message);
	}

	/** 取出所有排队但还没被注入的消息 (中断后放回输入框)。 */
	drainQueues(): AgentMessage[] {
		return [...this.steeringQueue.splice(0), ...this.followUpQueue.splice(0)];
	}

	abort(): void {
		this.abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.runPromise ?? Promise.resolve();
	}

	private normalize(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
		if (Array.isArray(input)) return input;
		if (typeof input !== "string") return [input];
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }, ...(images ?? [])];
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private snapshot(): AgentContext {
		return {
			systemPrompt: this.state.systemPrompt,
			messages: this.state.messages.slice(),
			tools: this.state.tools.slice(),
		};
	}

	private loopConfig(): AgentLoopConfig {
		return {
			model: this.state.model,
			streamFn: this.streamFn,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			prepareNextTurn: this.prepareNextTurn
				? async (context) => {
						const update = await this.prepareNextTurn?.(context);
						// loop 内部的上下文换掉了，Agent 的状态也要同步。
						if (update?.messages) this.state.messages = update.messages.slice();
						if (update?.systemPrompt !== undefined) this.state.systemPrompt = update.systemPrompt;
						if (update?.tools) this.state.tools = update.tools.slice();
						if (update?.model) this.state.model = update.model;
						return update;
					}
				: undefined,
			// 每次只取一条插话，让模型逐条处理。
			getSteeringMessages: async () => this.steeringQueue.splice(0, 1),
			getFollowUpMessages: async () => this.followUpQueue.splice(0, 1),
			toolExecution: this.toolExecution,
			sessionId: this.sessionId,
		};
	}

	private async run(executor: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
		this.abortController = new AbortController();
		this.state.isRunning = true;
		this.state.errorMessage = undefined;
		const signal = this.abortController.signal;
		this.runPromise = (async () => {
			try {
				await executor(signal);
			} catch (error) {
				// loop 的约定是不抛异常；万一抛了 (例如监听器出错)，转成一条失败消息。
				await this.handleFailure(error, signal.aborted);
			} finally {
				this.state.isRunning = false;
				this.state.streamingMessage = undefined;
				this.state.pendingToolCalls = new Set();
				this.abortController = undefined;
			}
		})();
		await this.runPromise;
	}

	private async handleFailure(error: unknown, aborted: boolean): Promise<void> {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: this.state.model.api,
			provider: this.state.model.provider,
			model: this.state.model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		await this.handle({ type: "message_start", message });
		await this.handle({ type: "message_end", message });
		await this.handle({ type: "agent_end", messages: [message] });
	}

	/** 先更新自身状态，再通知订阅者。订阅者看到事件时，state 已经是最新的。 */
	private async handle(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.state.streamingMessage = event.message;
				break;
			case "message_end":
				this.state.streamingMessage = undefined;
				this.state.messages.push(event.message);
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this.state.errorMessage = event.message.errorMessage;
				}
				break;
			case "tool_execution_start":
				this.state.pendingToolCalls.add(event.toolCallId);
				break;
			case "tool_execution_end":
				this.state.pendingToolCalls.delete(event.toolCallId);
				break;
		}
		for (const listener of this.listeners) await listener(event);
	}
}

export function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}
