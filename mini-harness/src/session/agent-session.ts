/**
 * 把各层组装起来：Agent + 会话 + 上下文 + 压缩 + 扩展 + 重试。
 *
 * 对应 pi 的 packages/coding-agent/src/core/agent-session.ts (4000+ 行)。
 * 所有运行模式 (交互、print、json、rpc) 共用这一个类，模式只负责输入输出 (第 9 章)。
 *
 *                 ┌─────────────── AgentSession ───────────────┐
 *   prompt() ──▶  │ 模板/skill 展开 → input 事件 → 扩展命令      │
 *                 │ before_agent_start → Agent.prompt()         │
 *                 │   ├ transformContext = 扩展 context 事件     │
 *                 │   ├ beforeToolCall  = 扩展 tool_call 事件    │
 *                 │   ├ afterToolCall   = 扩展 tool_result 事件  │
 *                 │   └ prepareNextTurn = 自动压缩               │
 *                 │ 事件 → 扩展 → 订阅者 → 写入会话文件          │
 *                 │ 失败 → 溢出则压缩重试 / 临时错误则退避重试    │
 *                 └─────────────────────────────────────────────┘
 */

import { Agent } from "../agent/agent.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../agent/types.ts";
import { isContextOverflow, isRetryableError } from "../ai/errors.ts";
import { type StreamFn, stream as defaultStream } from "../ai/stream.ts";
import type { AssistantMessage, ImageContent, Model } from "../ai/types.ts";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	generateSummary,
	prepareCompaction,
	shouldCompact,
} from "../compaction/compaction.ts";
import { DEFAULT_SETTINGS, type RetrySettings } from "../config.ts";
import { expandTemplate } from "../context/prompt-templates.ts";
import { expandSkillCommand } from "../context/skills.ts";
import { buildSystemPrompt } from "../context/system-prompt.ts";
import { ExtensionRunner } from "../extensions/runner.ts";
import type { Extension, ExtensionActions, ExtensionContext, ExtensionUI } from "../extensions/types.ts";
import type { Resources } from "../resources.ts";
import type { SessionManager } from "./session-manager.ts";

export type SessionEvent =
	| AgentEvent
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "compaction_end"; summary?: string; tokensBefore?: number; error?: string }
	| { type: "auto_retry"; attempt: number; delayMs: number; error: string }
	| { type: "extension_error"; path: string; event: string; error: string };

export interface AgentSessionOptions {
	cwd: string;
	model: Model;
	sessionManager: SessionManager;
	tools: AgentTool[];
	resources?: Resources;
	extensions?: Extension[];
	/** 扩展加载时拿到的 actions 对象；绑定时用真实实现替换它的方法。 */
	extensionActions?: ExtensionActions;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
	compaction?: CompactionSettings;
	retry?: RetrySettings;
	ui?: ExtensionUI;
	hasUI?: boolean;
}

const NO_UI: ExtensionUI = {
	notify: (message, level) => console.error(`[${level ?? "info"}] ${message}`),
	confirm: async () => false,
	select: async () => undefined,
	input: async () => undefined,
};

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly runner: ExtensionRunner;
	readonly cwd: string;
	readonly resources: Resources;
	private readonly allTools: AgentTool[];
	private activeToolNames: string[];
	private readonly streamFn: StreamFn;
	private readonly getApiKey?: AgentSessionOptions["getApiKey"];
	private readonly compactionSettings: CompactionSettings;
	private readonly retrySettings: RetrySettings;
	private readonly listeners = new Set<(event: SessionEvent) => void | Promise<void>>();
	private readonly ui: ExtensionUI;
	private readonly hasUI: boolean;
	private retryAttempt = 0;
	private retryAbort?: AbortController;

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.sessionManager = options.sessionManager;
		this.resources = options.resources ?? { contextFiles: [], skills: [], templates: [], extensionPaths: [] };
		this.streamFn = options.streamFn ?? defaultStream;
		this.getApiKey = options.getApiKey;
		this.compactionSettings = options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
		this.retrySettings = options.retry ?? DEFAULT_SETTINGS.retry;
		this.ui = options.ui ?? NO_UI;
		this.hasUI = options.hasUI ?? false;

		this.runner = new ExtensionRunner(options.extensions ?? [], () => this.extensionContext());
		this.runner.onError((error) => void this.emit({ type: "extension_error", ...error }));
		// 扩展工具和内置工具同名时，扩展的覆盖内置的。
		const byName = new Map<string, AgentTool>();
		for (const tool of [...options.tools, ...this.runner.getTools()]) byName.set(tool.name, tool);
		this.allTools = [...byName.values()];
		this.activeToolNames = this.allTools.map((tool) => tool.name);

		// 恢复会话：从会话树重建上下文。
		const restored = this.sessionManager.buildContext();
		this.agent = new Agent({
			model: options.model,
			messages: restored.messages,
			tools: this.activeTools(),
			streamFn: this.streamFn,
			getApiKey: this.getApiKey,
			sessionId: this.sessionManager.sessionId,
			transformContext: async (messages) => (this.runner.hasHandlers("context") ? this.runner.emitContext(messages) : messages),
			beforeToolCall: async ({ toolCall, args }) =>
				this.runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args }),
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const override = await this.runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args,
					content: result.content,
					isError,
				});
				return override;
			},
			prepareNextTurn: async (context) => this.compactBetweenTurns(context.messages),
		});
		this.agent.state.systemPrompt = this.buildSystemPrompt();
		this.agent.subscribe((event) => this.handleAgentEvent(event));

		if (options.extensionActions) this.bindExtensionActions(options.extensionActions);
	}

	// ---------- 扩展绑定 ----------

	private bindExtensionActions(actions: ExtensionActions): void {
		actions.sendUserMessage = (text) => {
			if (this.agent.state.isRunning) this.agent.followUp(text);
			else void this.prompt(text);
		};
		actions.appendEntry = (customType, data) => {
			this.sessionManager.appendCustom(customType, data);
		};
		actions.setActiveTools = (names) => this.setActiveTools(names);
		actions.getActiveTools = () => [...this.activeToolNames];
		actions.getAllTools = () => this.allTools.map((tool) => tool.name);
	}

	private extensionContext(): ExtensionContext {
		return {
			cwd: this.cwd,
			hasUI: this.hasUI,
			ui: this.ui,
			model: this.agent.state.model,
			sessionManager: this.sessionManager,
			abort: () => this.abort(),
		};
	}

	async start(): Promise<void> {
		await this.runner.emit({ type: "session_start" });
	}

	async dispose(): Promise<void> {
		this.abort();
		await this.runner.emit({ type: "session_shutdown" });
	}

	// ---------- 工具与 system prompt ----------

	private activeTools(): AgentTool[] {
		return this.allTools.filter((tool) => this.activeToolNames.includes(tool.name));
	}

	setActiveTools(names: string[]): void {
		this.activeToolNames = names.filter((name) => this.allTools.some((tool) => tool.name === name));
		this.agent.state.tools = this.activeTools();
		// 工具变了，tools 和 rules 两段都要重建。
		this.agent.state.systemPrompt = this.buildSystemPrompt();
	}

	getActiveToolNames(): string[] {
		return [...this.activeToolNames];
	}

	/** 会话创建后追加工具，并立即启用 (例如依赖 session 本身的 code mode 工具)。 */
	addTool(tool: AgentTool): void {
		this.allTools.push(tool);
		this.setActiveTools([...this.activeToolNames, tool.name]);
	}

	getAllTools(): AgentTool[] {
		return [...this.allTools];
	}

	private buildSystemPrompt(): string {
		return buildSystemPrompt({
			cwd: this.cwd,
			tools: this.activeTools(),
			customPrompt: this.resources.customPrompt,
			appendPrompt: this.resources.appendPrompt,
			contextFiles: this.resources.contextFiles,
			skills: this.resources.skills,
		});
	}

	// ---------- 事件 ----------

	subscribe(listener: (event: SessionEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async emit(event: SessionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}

	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		// 1. 扩展先看到事件
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "turn_end" || event.type === "message_end") {
			await this.runner.emit(event);
		}
		// 2. 再通知 UI 等订阅者
		await this.emit(event);
		// 3. 完整的消息写入会话文件。流式中间状态不落盘。
		if (event.type === "message_end") this.sessionManager.appendMessage(event.message);
	}

	// ---------- 提交输入 ----------

	/**
	 * 处理一条用户输入。顺序：
	 *   扩展命令 (/name) → 模板 / skill 展开 → input 事件 → 压缩检查 → before_agent_start → 运行
	 */
	async prompt(text: string, options: { images?: ImageContent[] } = {}): Promise<void> {
		const command = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
		if (command) {
			const registered = this.runner.getCommand(command[1]);
			if (registered) {
				await registered.handler(command[2] ?? "", this.extensionContext());
				return;
			}
		}

		let expanded = expandSkillCommand(text, this.resources.skills) ?? expandTemplate(text, this.resources.templates) ?? text;

		const input = await this.runner.emitInput(expanded);
		if (input.action === "handled") return;
		if (input.action === "transform") expanded = input.text;

		await this.compactIfNeeded("threshold");

		const baseSystemPrompt = this.buildSystemPrompt();
		const before = await this.runner.emitBeforeAgentStart({ type: "before_agent_start", prompt: expanded, systemPrompt: baseSystemPrompt });
		this.agent.state.systemPrompt = before.systemPrompt ?? baseSystemPrompt;

		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: expanded }, ...(options.images ?? [])],
				timestamp: Date.now(),
			},
		];
		if (before.message) {
			messages.push({
				role: "custom",
				customType: before.message.customType,
				content: before.message.content,
				display: before.message.display ?? false,
				timestamp: Date.now(),
			});
		}

		this.retryAttempt = 0;
		await this.agent.prompt(messages);
		await this.recoverFromFailure();
	}

	steer(text: string): void {
		this.agent.steer(text);
	}

	followUp(text: string): void {
		this.agent.followUp(text);
	}

	abort(): void {
		this.retryAbort?.abort();
		this.agent.abort();
	}

	// ---------- 失败恢复 ----------

	/**
	 * run 以错误结束后：
	 * - 上下文溢出：压缩，然后从压缩后的上下文继续 (只尝试一次)；
	 * - 临时错误：指数退避后继续，最多 maxRetries 次。
	 * 失败的 assistant 消息仍然留在会话文件里 (便于排查)，
	 * 但从内存上下文中移除，发请求时 transformMessages 也会跳过它。
	 */
	private async recoverFromFailure(): Promise<void> {
		let overflowAttempted = false;
		while (true) {
			const last = this.agent.state.messages.at(-1);
			if (last?.role !== "assistant") return;
			const contextWindow = this.agent.state.model.contextWindow;

			if (!overflowAttempted && isContextOverflow(last, contextWindow)) {
				overflowAttempted = true;
				this.agent.state.messages.pop();
				const ok = await this.compactIfNeeded("overflow", true);
				if (!ok) return;
				await this.agent.continue();
				continue;
			}

			if (this.retrySettings.enabled && isRetryableError(last, contextWindow) && this.retryAttempt < this.retrySettings.maxRetries) {
				this.retryAttempt += 1;
				const delayMs = this.retrySettings.baseDelayMs * 2 ** (this.retryAttempt - 1);
				await this.emit({ type: "auto_retry", attempt: this.retryAttempt, delayMs, error: last.errorMessage ?? "" });
				this.retryAbort = new AbortController();
				const aborted = await sleep(delayMs, this.retryAbort.signal);
				this.retryAbort = undefined;
				if (aborted) return;
				this.agent.state.messages.pop();
				await this.agent.continue();
				continue;
			}
			return;
		}
	}

	// ---------- 压缩 ----------

	getContextUsage(): { tokens: number; contextWindow: number; percent: number } {
		const tokens = estimateContextTokens(this.agent.state.messages);
		const contextWindow = this.agent.state.model.contextWindow;
		return { tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) };
	}

	/** run 进行中、两个 turn 之间检查：工具结果可能让上下文一下子变得很大。 */
	private async compactBetweenTurns(messages: AgentMessage[]) {
		const tokens = estimateContextTokens(messages);
		if (!shouldCompact(tokens, this.agent.state.model.contextWindow, this.compactionSettings)) return undefined;
		const ok = await this.runCompaction("threshold");
		return ok ? { messages: this.sessionManager.buildContext().messages } : undefined;
	}

	private async compactIfNeeded(reason: "threshold" | "overflow", force = false): Promise<boolean> {
		const tokens = estimateContextTokens(this.agent.state.messages);
		if (!force && !shouldCompact(tokens, this.agent.state.model.contextWindow, this.compactionSettings)) return false;
		const ok = await this.runCompaction(reason);
		if (ok) this.agent.state.messages = this.sessionManager.buildContext().messages;
		return ok;
	}

	/** 手动压缩 (/compact)。 */
	async compact(customInstructions?: string): Promise<boolean> {
		const ok = await this.runCompaction("manual", customInstructions);
		if (ok) this.agent.state.messages = this.sessionManager.buildContext().messages;
		return ok;
	}

	private async runCompaction(reason: "manual" | "threshold" | "overflow", customInstructions?: string): Promise<boolean> {
		const settings = reason === "overflow" ? { ...this.compactionSettings, keepRecentTokens: Math.floor(this.compactionSettings.keepRecentTokens / 2) } : this.compactionSettings;
		const preparation = prepareCompaction(this.sessionManager, settings);
		if (!preparation) return false;
		await this.emit({ type: "compaction_start", reason });
		try {
			const hook = await this.runner.emitBeforeCompact({ type: "session_before_compact", preparation });
			if (hook?.cancel) {
				await this.emit({ type: "compaction_end", error: "cancelled by extension" });
				return false;
			}
			const model = this.agent.state.model;
			const summary =
				hook?.summary ??
				(await generateSummary(preparation.toSummarize, model, this.streamFn, {
					apiKey: await this.getApiKey?.(model.provider),
					previousSummary: preparation.previousSummary,
					customInstructions,
				}));
			this.sessionManager.appendCompaction(summary, preparation.firstKeptEntryId, preparation.tokensBefore);
			await this.emit({ type: "compaction_end", summary, tokensBefore: preparation.tokensBefore });
			return true;
		} catch (error) {
			await this.emit({ type: "compaction_end", error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	// ---------- 模型与分支 ----------

	setModel(model: Model): void {
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/**
	 * 跳到会话树上的另一个位置继续 (/tree)。
	 * summarize 为 true 时，先对将要离开的分支做摘要，附在新位置上。
	 */
	async navigateTo(entryId: string, options: { summarize?: boolean } = {}): Promise<void> {
		if (this.agent.state.isRunning) throw new Error("Cannot navigate while the agent is running");
		if (options.summarize) {
			const target = new Set(this.sessionManager.getPath(entryId).map((entry) => entry.id));
			const abandoned = this.sessionManager
				.getPath()
				.filter((entry) => !target.has(entry.id) && entry.type === "message")
				.map((entry) => (entry.type === "message" ? entry.message : undefined))
				.filter((message): message is AgentMessage => message !== undefined);
			if (abandoned.length > 0) {
				const model = this.agent.state.model;
				const summary = await generateSummary(abandoned, model, this.streamFn, { apiKey: await this.getApiKey?.(model.provider) });
				this.sessionManager.branchWithSummary(entryId, summary);
			} else {
				this.sessionManager.branch(entryId);
			}
		} else {
			this.sessionManager.branch(entryId);
		}
		this.agent.state.messages = this.sessionManager.buildContext().messages;
	}

	get model(): Model {
		return this.agent.state.model;
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	lastAssistant(): AssistantMessage | undefined {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (message.role === "assistant") return message;
		}
		return undefined;
	}
}

/** 可被中断的等待。返回 true 表示被中断。 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
