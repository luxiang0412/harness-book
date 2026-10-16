/**
 * 第 1 章：统一的消息模型。
 *
 * 这里的类型是 pi-ai (packages/ai/src/types.ts) 的精简版。
 * 所有 provider 适配器都把各自的协议转换成这一套类型，
 * 上层 (agent loop、会话、UI) 只和这一套类型打交道。
 */

// ---------- 内容块 ----------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** base64 编码的图片数据 */
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** provider 返回的签名。回放给同一个模型时需要原样带回。 */
	signature?: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/**
	 * 模型发来的完整参数文本不是合法的 JSON 对象时设置，此时 arguments 是 {}。
	 * 里面带着原始文本，参数校验会把它作为错误结果交还给模型，工具不会执行。
	 */
	argumentsError?: string;
}

// ---------- 消息 ----------

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/**
 * 模型为什么停下：
 * - stop: 正常结束
 * - length: 撞上了输出 token 上限，内容可能被截断
 * - toolUse: 模型想调用工具
 * - error / aborted: 失败或被用户中断
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------- 工具声明 ----------

/** 一个 JSON Schema 对象。mini-harness 不依赖 schema 库，直接写普通对象。 */
export type JsonSchema = {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	description?: string;
	enum?: unknown[];
	[key: string]: unknown;
};

/** 发给模型的工具声明：只有名字、描述和参数 schema，不含执行逻辑。 */
export interface Tool {
	name: string;
	description: string;
	parameters: JsonSchema;
}

// ---------- 模型与请求 ----------

export type Api = "anthropic-messages" | "openai-completions" | "faux";

export interface Model {
	id: string;
	name: string;
	api: Api;
	provider: string;
	baseUrl: string;
	/** 上下文窗口大小 (token)，第 7 章的压缩会用到。 */
	contextWindow: number;
	/** 单次回复的最大输出 token。 */
	maxTokens: number;
	/** 是否支持 thinking / reasoning。 */
	reasoning: boolean;
}

/** 一次请求的完整输入。 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface StreamOptions {
	apiKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	/** 用于 provider 端 prompt cache 的会话标识。 */
	sessionId?: string;
}

// ---------- 流式事件 ----------

/**
 * 一次模型回复的事件序列：
 *
 *   start → (text_* | thinking_* | toolcall_*)* → done
 *   start → ... → error
 *
 * 每个事件都带着 partial：到目前为止拼好的 AssistantMessage。
 * UI 只需要渲染 partial，不需要自己拼接 delta。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: AssistantMessage };

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** 新建一条空的 assistant 消息，provider 适配器在它上面逐步填充内容。 */
export function createAssistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** 把消息内容 (字符串或内容块数组) 中的文本拼起来。 */
export function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}
