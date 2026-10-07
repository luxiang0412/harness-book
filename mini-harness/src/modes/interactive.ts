/**
 * 第 8 章 / 第 9 章：交互模式。
 *
 * 对应 pi 的 packages/coding-agent/src/modes/interactive/interactive-mode.ts (7000 行)。
 *
 * 职责只有两件：
 * - 把用户按键变成对 AgentSession 的调用 (prompt / steer / followUp / abort / 内置命令)；
 * - 把 SessionEvent 变成组件状态，然后请求重新渲染。
 * 所有 agent 逻辑都在 AgentSession 里，这里不碰。
 */

import { contentText } from "../ai/types.ts";
import type { ExtensionUI } from "../extensions/types.ts";
import { findModel } from "../ai/models.ts";
import type { AgentSession, SessionEvent } from "../session/agent-session.ts";
import { ChatView, Editor, Footer } from "../tui/components.ts";
import { matchAction, printable } from "../tui/keys.ts";
import { TUI } from "../tui/tui.ts";

const HELP = `Commands:
  /compact [focus]   summarize old history to free context
  /model <spec>      switch model (e.g. anthropic/claude-sonnet-5-5)
  /tree              list user messages with entry ids
  /branch <id>       continue from an earlier entry (+ summary of the abandoned branch)
  /tools [names…]    show or set active tools
  /session           show session file and token usage
  /quit              exit
Keys: Enter submit (steer while running) · Alt+Enter follow-up · Esc abort · Ctrl+C exit`;

export class InteractiveMode {
	private readonly session: AgentSession;
	private readonly tui: TUI;
	private readonly chat = new ChatView();
	private readonly editor = new Editor();
	private readonly footer = new Footer();
	/** 扩展提问时，下一次提交的文本交给这个回调，而不是当作 prompt。 */
	private pendingAnswer?: (text: string) => void;
	private resolveExit!: () => void;

	constructor(session: AgentSession) {
		this.session = session;
		this.tui = new TUI({
			get columns() {
				return process.stdout.columns ?? 80;
			},
			get rows() {
				return process.stdout.rows ?? 24;
			},
			write: (data) => process.stdout.write(data),
		});
		this.tui.addChild(this.chat);
		this.tui.addChild(this.editor);
		this.tui.addChild(this.footer);
	}

	/** 给扩展用的 UI 实现：问题显示在输入框上方，用户的下一次输入就是答案。 */
	createExtensionUI(): ExtensionUI {
		const ask = (question: string) =>
			new Promise<string>((resolve) => {
				this.editor.question = question;
				this.pendingAnswer = (text) => {
					this.editor.question = undefined;
					resolve(text);
				};
				this.tui.requestRender();
			});
		return {
			notify: (message) => {
				this.chat.notices.push(message);
				this.tui.requestRender();
			},
			confirm: async (title, message) => /^y(es)?$/i.test((await ask(`${title}: ${message} [y/N]`)).trim()),
			select: async (title, options) => {
				const answer = await ask(`${title}\n${options.map((option, i) => `  ${i + 1}. ${option}`).join("\n")}\nNumber:`);
				return options[Number(answer.trim()) - 1];
			},
			input: async (prompt) => (await ask(prompt)) || undefined,
		};
	}

	async run(): Promise<void> {
		this.chat.messages = [...this.session.messages];
		this.chat.notices.push("mini-harness — /help for commands");
		this.updateFooter();
		this.session.subscribe((event) => this.onEvent(event));

		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.on("data", (data) => this.onInput(data.toString("utf-8")));
		process.stdout.on("resize", () => this.tui.requestRender());
		this.tui.render();

		await new Promise<void>((resolve) => (this.resolveExit = resolve));
		process.stdin.setRawMode?.(false);
		process.stdin.pause();
		this.tui.stop();
	}

	private onInput(data: string): void {
		const action = matchAction(data);
		const running = this.session.agent.state.isRunning;
		switch (action) {
			case "exit":
				if (running) this.session.abort();
				else this.resolveExit();
				return;
			case "abort":
				if (running) this.session.abort();
				return;
			case "backspace":
				this.editor.text = [...this.editor.text].slice(0, -1).join("");
				break;
			case "clearLine":
				this.editor.text = "";
				break;
			case "newline":
				this.editor.text += "\n";
				break;
			case "submit":
			case "followUp":
				this.submit(action === "followUp");
				break;
			default:
				this.editor.text += printable(data);
		}
		this.tui.requestRender();
	}

	private submit(asFollowUp: boolean): void {
		const text = this.editor.text.trim();
		this.editor.text = "";
		if (this.pendingAnswer) {
			const answer = this.pendingAnswer;
			this.pendingAnswer = undefined;
			answer(text);
			return;
		}
		if (!text) return;
		if (this.session.agent.state.isRunning) {
			// 运行中：Enter = 插话，Alt+Enter = 追加任务
			if (asFollowUp) this.session.followUp(text);
			else this.session.steer(text);
			this.chat.notices.push(`(queued ${asFollowUp ? "follow-up" : "steer"}: ${text})`);
			return;
		}
		void this.handleCommand(text).then((handled) => {
			if (handled) return;
			void this.session
				.prompt(text)
				.catch((error) => this.notice(String(error)))
				.finally(() => {
					// isRunning 在 run 结束后才变为 false，晚于 agent_end 事件，这里再刷新一次。
					this.updateFooter();
					this.tui.requestRender();
				});
		});
	}

	private notice(message: string): void {
		this.chat.notices.push(message);
		this.tui.requestRender();
	}

	/** 内置命令。返回 false 表示不是内置命令，交给 session.prompt (可能是扩展命令或模板)。 */
	private async handleCommand(text: string): Promise<boolean> {
		const [command, ...rest] = text.split(/\s+/);
		const args = rest.join(" ");
		this.chat.notices = [];
		switch (command) {
			case "/help":
				this.notice(HELP);
				return true;
			case "/quit":
				this.resolveExit();
				return true;
			case "/compact":
				this.notice((await this.session.compact(args || undefined)) ? "Compacted." : "Nothing to compact.");
				this.chat.messages = [...this.session.messages];
				return true;
			case "/model": {
				const model = findModel(args);
				if (!model) this.notice(`Unknown model: ${args}`);
				else {
					this.session.setModel(model);
					this.updateFooter();
				}
				return true;
			}
			case "/tree": {
				const lines = this.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "user")
					.map((entry) => (entry.type === "message" && entry.message.role === "user" ? `${entry.id}  ${contentText(entry.message.content).slice(0, 60)}` : ""));
				this.notice(lines.join("\n") || "(empty)");
				return true;
			}
			case "/branch": {
				// 从某条用户消息"之前"重新开始：分支点是它的父节点。
				const entry = this.session.sessionManager.getEntry(args);
				if (!entry?.parentId) {
					this.notice("Usage: /branch <entry id from /tree> (not the first message)");
					return true;
				}
				await this.session.navigateTo(entry.parentId, { summarize: true });
				this.chat.messages = [...this.session.messages];
				this.notice(`Branched before ${args}.`);
				return true;
			}
			case "/tools":
				if (args) this.session.setActiveTools(args.split(/[\s,]+/));
				this.notice(`Active tools: ${this.session.getActiveToolNames().join(", ")}`);
				return true;
			case "/session": {
				const usage = this.session.getContextUsage();
				this.notice(`File: ${this.session.sessionManager.file ?? "(in memory)"}\nContext: ${usage.tokens}/${usage.contextWindow} tokens (${usage.percent}%)`);
				return true;
			}
			default:
				return false;
		}
	}

	private updateFooter(): void {
		const usage = this.session.getContextUsage();
		this.footer.model = `${this.session.model.provider}/${this.session.model.id}`;
		this.footer.usage = `${usage.percent}% of ${Math.round(usage.contextWindow / 1000)}k`;
		this.footer.status = this.session.agent.state.isRunning ? "working… (Esc to abort)" : "";
	}

	private onEvent(event: SessionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") this.chat.streaming = event.message;
				break;
			case "message_end":
				this.chat.streaming = undefined;
				this.chat.messages = [...this.session.messages];
				break;
			case "tool_execution_update":
				this.chat.toolOutput.set(event.toolCallId, contentText(event.partialResult.content));
				break;
			case "tool_execution_end":
				this.chat.toolOutput.delete(event.toolCallId);
				break;
			case "compaction_start":
				this.chat.notices.push(`Compacting context (${event.reason})…`);
				break;
			case "compaction_end":
				this.chat.notices.push(event.error ? `Compaction failed: ${event.error}` : `Compacted ${event.tokensBefore} tokens.`);
				this.chat.messages = [...this.session.messages];
				break;
			case "auto_retry":
				this.chat.notices.push(`Retry ${event.attempt} in ${event.delayMs}ms: ${event.error}`);
				break;
			case "extension_error":
				this.chat.notices.push(`Extension error (${event.path}, ${event.event}): ${event.error}`);
				break;
			case "agent_end":
				this.chat.notices = [];
				break;
		}
		this.updateFooter();
		this.tui.requestRender();
	}
}
