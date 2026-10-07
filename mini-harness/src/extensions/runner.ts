/**
 * 第 10 章：分发事件给扩展。
 *
 * 对应 pi 的 packages/coding-agent/src/core/extensions/runner.ts。
 *
 * 不同事件的结果合并规则不同，这是扩展系统设计的核心：
 *
 *   事件            合并规则                          出错时
 *   ─────────────   ───────────────────────────────   ─────────────────────
 *   观察型          忽略返回值                         记录错误，继续下一个
 *   tool_call       第一个 block 的结果胜出，立即返回   抛出 → 工具被阻止
 *   tool_result     链式：后一个看到前一个的修改        记录错误，继续
 *   context         链式改写消息列表                    记录错误，继续
 *   input           链式；handled 立即返回              记录错误，继续
 *   before_compact  cancel 立即返回                     记录错误，继续
 *
 * tool_call 出错时选择"阻止"而不是"放行"：权限检查扩展崩溃，不应该等于批准。
 */

import type { AgentMessage, AgentTool } from "../agent/types.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartResult,
	Extension,
	ExtensionContext,
	ExtensionEventMap,
	ExtensionEventName,
	ExtensionHandler,
	InputEventResult,
	RegisteredCommand,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "./types.ts";

export interface ExtensionError {
	path: string;
	event: string;
	error: string;
}

type ObserveEvent = Extract<ExtensionEventName, "session_start" | "session_shutdown" | "agent_start" | "agent_end" | "turn_end" | "message_end">;

export class ExtensionRunner {
	readonly extensions: Extension[];
	private readonly createContext: () => ExtensionContext;
	private readonly errorListeners = new Set<(error: ExtensionError) => void>();

	constructor(extensions: Extension[], createContext: () => ExtensionContext) {
		this.extensions = extensions;
		this.createContext = createContext;
	}

	onError(listener: (error: ExtensionError) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	private reportError(path: string, event: string, error: unknown): void {
		const report = { path, event, error: error instanceof Error ? error.message : String(error) };
		for (const listener of this.errorListeners) listener(report);
	}

	/** 按扩展加载顺序、再按注册顺序取出处理器。复制一份，避免处理器在分发中途注销自己。 */
	private handlers<K extends ExtensionEventName>(event: K): { path: string; handler: ExtensionHandler<K> }[] {
		return this.extensions.flatMap((extension) =>
			(extension.handlers.get(event) ?? []).slice().map((handler) => ({ path: extension.path, handler: handler as ExtensionHandler<K> })),
		);
	}

	hasHandlers(event: ExtensionEventName): boolean {
		return this.extensions.some((extension) => (extension.handlers.get(event)?.length ?? 0) > 0);
	}

	getTools(): AgentTool[] {
		const tools = new Map<string, AgentTool>();
		for (const extension of this.extensions) for (const [name, tool] of extension.tools) tools.set(name, tool);
		return [...tools.values()];
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (const extension of this.extensions) {
			const command = extension.commands.get(name);
			if (command) return command;
		}
		return undefined;
	}

	getCommands(): RegisteredCommand[] {
		return this.extensions.flatMap((extension) => [...extension.commands.values()]);
	}

	async emit<K extends ObserveEvent>(event: ExtensionEventMap[K][0] & { type: K }): Promise<void> {
		const ctx = this.createContext();
		for (const { path, handler } of this.handlers(event.type as K)) {
			try {
				await handler(event, ctx);
			} catch (error) {
				this.reportError(path, event.type, error);
			}
		}
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;
		for (const { handler } of this.handlers("tool_call")) {
			// 不捕获异常：让它传到 loop 的 beforeToolCall，在那里变成"阻止执行"。
			const handlerResult = await handler(event, ctx);
			if (handlerResult) {
				result = handlerResult;
				if (handlerResult.block) return handlerResult;
			}
		}
		return result;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const current = { ...event };
		let modified = false;
		for (const { path, handler } of this.handlers("tool_result")) {
			try {
				const result = await handler(current, ctx);
				if (result?.content) {
					current.content = result.content;
					modified = true;
				}
				if (result?.isError !== undefined) {
					current.isError = result.isError;
					modified = true;
				}
			} catch (error) {
				this.reportError(path, "tool_result", error);
			}
		}
		return modified ? { content: current.content, isError: current.isError } : undefined;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		// 深拷贝：扩展改写的是请求用的副本，不会污染会话里保存的原始消息。
		let current = structuredClone(messages);
		for (const { path, handler } of this.handlers("context")) {
			try {
				const result = await handler({ type: "context", messages: current }, ctx);
				if (result?.messages) current = result.messages;
			} catch (error) {
				this.reportError(path, "context", error);
			}
		}
		return current;
	}

	async emitInput(text: string): Promise<InputEventResult> {
		const ctx = this.createContext();
		let current = text;
		let transformed = false;
		for (const { path, handler } of this.handlers("input")) {
			try {
				const result = await handler({ type: "input", text: current }, ctx);
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					current = result.text;
					transformed = true;
				}
			} catch (error) {
				this.reportError(path, "input", error);
			}
		}
		return transformed ? { action: "transform", text: current } : { action: "continue" };
	}

	async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<BeforeAgentStartResult> {
		const ctx = this.createContext();
		const merged: BeforeAgentStartResult = {};
		let systemPrompt = event.systemPrompt;
		for (const { path, handler } of this.handlers("before_agent_start")) {
			try {
				const result = await handler({ ...event, systemPrompt }, ctx);
				if (result?.systemPrompt !== undefined) {
					systemPrompt = result.systemPrompt;
					merged.systemPrompt = systemPrompt;
				}
				if (result?.message) merged.message = result.message;
			} catch (error) {
				this.reportError(path, "before_agent_start", error);
			}
		}
		return merged;
	}

	async emitBeforeCompact(event: SessionBeforeCompactEvent): Promise<SessionBeforeCompactResult | undefined> {
		const ctx = this.createContext();
		let result: SessionBeforeCompactResult | undefined;
		for (const { path, handler } of this.handlers("session_before_compact")) {
			try {
				const handlerResult = await handler(event, ctx);
				if (handlerResult) {
					result = handlerResult;
					if (handlerResult.cancel) return handlerResult;
				}
			} catch (error) {
				this.reportError(path, "session_before_compact", error);
			}
		}
		return result;
	}
}
