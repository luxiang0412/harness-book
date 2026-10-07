/**
 * 第 2 章 / 第 3 章 / 第 4 章：agent 层的类型。
 *
 * 对应 pi 的 packages/agent/src/types.ts。
 */

import type { AssistantMessageEvent, ImageContent, Message, Model, TextContent, Tool, ToolCall, ToolResultMessage } from "../ai/types.ts";
import type { StreamFn } from "../ai/stream.ts";

// ---------- 消息 ----------

/** 压缩 (第 7 章) 或切换分支 (第 6 章) 时生成的摘要。发给模型时转成 user 消息。 */
export interface SummaryMessage {
	role: "summary";
	kind: "compaction" | "branch";
	summary: string;
	timestamp: number;
}

/** 扩展注入的消息 (第 10 章)。display 控制 UI 是否显示。 */
export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

/**
 * AgentMessage = LLM 认识的消息 + 应用自己的消息。
 * 会话和 UI 存的是 AgentMessage；只在调用模型前才转换成 Message (见 convertToLlm)。
 */
export type AgentMessage = Message | SummaryMessage | CustomMessage;

// ---------- 工具 ----------

export interface AgentToolResult<TDetails = unknown> {
	/** 返回给模型看的内容。 */
	content: (TextContent | ImageContent)[];
	/** 给 UI / 日志看的结构化信息，不发给模型。例如 edit 工具的 diff。 */
	details?: TDetails;
	/** 不抛异常也能报告失败。 */
	isError?: boolean;
	/** 提示 agent 在这批工具执行完后停下，不再请求模型 (所有结果都要求停才会停)。 */
	terminate?: boolean;
}

export type ToolUpdateCallback = (partial: AgentToolResult) => void;

/** 可执行的工具 = 发给模型的声明 + 执行函数。 */
export interface AgentTool<TArgs = any, TDetails = unknown> extends Tool {
	/** UI 上显示的名字。 */
	label?: string;
	/** "sequential" 的工具不会和其他工具并行执行 (第 3 章)。 */
	executionMode?: "sequential" | "parallel";
	/** 第 5 章：一行简介，进入 system prompt 的 <tools> 段。 */
	promptSnippet?: string;
	/** 第 5 章：这个工具自带的使用规则，进入 <rules> 段。 */
	promptGuidelines?: string[];
	execute(toolCallId: string, args: TArgs, signal: AbortSignal | undefined, onUpdate: ToolUpdateCallback): Promise<AgentToolResult<TDetails>>;
}

// ---------- loop 配置 ----------

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools: AgentTool[];
}

export interface BeforeToolCallContext {
	toolCall: ToolCall;
	args: Record<string, unknown>;
	context: AgentContext;
}

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface AfterToolCallContext {
	toolCall: ToolCall;
	args: Record<string, unknown>;
	result: AgentToolResult;
	isError: boolean;
	context: AgentContext;
}

/** 在两个 turn 之间替换状态，例如压缩后的新历史 (第 7 章)。 */
export interface TurnUpdate {
	messages?: AgentMessage[];
	systemPrompt?: string;
	tools?: AgentTool[];
	model?: Model;
}

export interface AgentLoopConfig {
	model: Model;
	streamFn: StreamFn;
	/** AgentMessage[] → Message[]。过滤掉 UI 专用消息，把摘要等转成 user 消息。 */
	convertToLlm: (messages: AgentMessage[]) => Message[];
	/** 发请求前改写上下文，例如剪枝。 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 每次请求都重新取 key，适配会过期的 OAuth token。 */
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<Partial<AgentToolResult> | undefined>;
	/** 运行中插话 (第 4 章)：当前 turn 的工具执行完后注入。 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	/** 追加任务 (第 4 章)：agent 本来要停下时注入。 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	/** 两个 turn 之间调用，可以替换上下文 (第 7 章压缩就挂在这里)。 */
	prepareNextTurn?: (context: AgentContext) => Promise<TurnUpdate | undefined>;
	toolExecution?: "sequential" | "parallel";
	maxTokens?: number;
	sessionId?: string;
}

// ---------- 事件 ----------

/**
 * 一次 run 的事件序列 (第 2 章有完整示例)：
 *
 *   agent_start
 *     turn_start
 *       message_start/end (user)
 *       message_start → message_update* → message_end (assistant)
 *       tool_execution_start → tool_execution_update* → tool_execution_end
 *       message_start/end (toolResult)
 *     turn_end
 *     turn_start ...
 *   agent_end
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; event: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
