/**
 * 第 10 章：扩展 API。
 *
 * 对应 pi 的 packages/coding-agent/src/core/extensions/types.ts (2000+ 行)。
 * 这里保留最核心的部分：事件钩子、注册工具、注册命令、少量运行时动作。
 *
 * 一个扩展就是一个默认导出工厂函数的 TypeScript 模块：
 *
 *   export default function (mini: ExtensionAPI) {
 *     mini.on("tool_call", async (event, ctx) => { ... });
 *     mini.registerTool({ ... });
 *   }
 */

import type { AgentMessage, AgentTool } from "../agent/types.ts";
import type { ImageContent, Model, TextContent, ToolResultMessage } from "../ai/types.ts";
import type { CompactionPreparation } from "../compaction/compaction.ts";
import type { SessionManager } from "../session/session-manager.ts";

// ---------- UI 能力 ----------

/** 扩展通过它和用户交互。不同运行模式提供不同实现 (第 9 章)。 */
export interface ExtensionUI {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(prompt: string): Promise<string | undefined>;
}

export interface ExtensionContext {
	cwd: string;
	/** 没有 UI 时 (print/json 模式) 为 false，此时 ui 的交互方法返回默认值。 */
	hasUI: boolean;
	ui: ExtensionUI;
	model: Model;
	sessionManager: SessionManager;
	/** 中断当前 run。 */
	abort(): void;
}

// ---------- 事件 ----------
// 两类事件：
// - 观察型：只通知，返回值被忽略 (agent_start、message_end ...)
// - 拦截型：返回值会改变行为 (tool_call 可以阻止执行、context 可以改写消息 ...)

export interface SessionStartEvent {
	type: "session_start";
}
export interface SessionShutdownEvent {
	type: "session_shutdown";
}
export interface InputEvent {
	type: "input";
	text: string;
}
/** 返回 handled 表示扩展已经处理了这条输入，不再发给模型。 */
export type InputEventResult = { action: "continue" } | { action: "transform"; text: string } | { action: "handled" };

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}
export interface BeforeAgentStartResult {
	/** 替换本次 run 的 system prompt。 */
	systemPrompt?: string;
	/** 在用户消息之后注入一条额外消息 (例如检索到的相关文档)。 */
	message?: { customType: string; content: string; display?: boolean };
}

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}
export interface ContextEventResult {
	messages?: AgentMessage[];
}

export interface ToolCallEvent {
	type: "tool_call";
	toolName: string;
	toolCallId: string;
	/** 可以直接修改参数对象。 */
	input: Record<string, unknown>;
}
export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
}

export interface AgentStartEvent {
	type: "agent_start";
}
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}
export interface TurnEndEvent {
	type: "turn_end";
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
}
/** cancel 取消压缩；summary 用扩展自己生成的摘要代替默认摘要。 */
export interface SessionBeforeCompactResult {
	cancel?: boolean;
	summary?: string;
}

export interface ExtensionEventMap {
	session_start: [SessionStartEvent, void];
	session_shutdown: [SessionShutdownEvent, void];
	input: [InputEvent, InputEventResult | undefined];
	before_agent_start: [BeforeAgentStartEvent, BeforeAgentStartResult | undefined];
	context: [ContextEvent, ContextEventResult | undefined];
	tool_call: [ToolCallEvent, ToolCallEventResult | undefined];
	tool_result: [ToolResultEvent, ToolResultEventResult | undefined];
	agent_start: [AgentStartEvent, void];
	agent_end: [AgentEndEvent, void];
	turn_end: [TurnEndEvent, void];
	message_end: [MessageEndEvent, void];
	session_before_compact: [SessionBeforeCompactEvent, SessionBeforeCompactResult | undefined];
}

export type ExtensionEventName = keyof ExtensionEventMap;
export type ExtensionHandler<K extends ExtensionEventName> = (
	event: ExtensionEventMap[K][0],
	ctx: ExtensionContext,
) => ExtensionEventMap[K][1] | Promise<ExtensionEventMap[K][1]>;

// ---------- 命令 ----------

export interface RegisteredCommand {
	name: string;
	description: string;
	handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

// ---------- 扩展 API ----------

export interface ExtensionAPI {
	on<K extends ExtensionEventName>(event: K, handler: ExtensionHandler<K>): () => void;
	registerTool(tool: AgentTool): void;
	registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;
	/** 以用户身份发送一条消息。agent 正在运行时进入 follow-up 队列。 */
	sendUserMessage(text: string): void;
	/** 把扩展状态写进会话 (不进入模型上下文)，恢复会话时可以读回来。 */
	appendEntry(customType: string, data: unknown): void;
	/** 设置启用的工具 (按名字)。 */
	setActiveTools(names: string[]): void;
	getActiveTools(): string[];
	getAllTools(): string[];
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

/** 加载后的扩展：它注册的所有东西都记录在这里。 */
export interface Extension {
	path: string;
	handlers: Map<string, ExtensionHandler<any>[]>;
	tools: Map<string, AgentTool>;
	commands: Map<string, RegisteredCommand>;
}

/** 运行时动作的实现，由 AgentSession 在绑定时注入。加载阶段调用会报错。 */
export interface ExtensionActions {
	sendUserMessage(text: string): void;
	appendEntry(customType: string, data: unknown): void;
	setActiveTools(names: string[]): void;
	getActiveTools(): string[];
	getAllTools(): string[];
}

