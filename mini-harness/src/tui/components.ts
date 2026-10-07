/**
 * 第 8 章：交互模式用到的组件。
 *
 * 每个组件只负责"把状态画成行"，不直接写终端。
 * 状态变化时调用 tui.requestRender()，由 TUI 统一做差分。
 */

import type { AgentMessage } from "../agent/types.ts";
import { contentText } from "../ai/types.ts";
import { style } from "./text.ts";
import type { Component } from "./tui.ts";

/** 对话记录：用户消息、assistant 回复、工具调用及结果。 */
export class ChatView implements Component {
	messages: AgentMessage[] = [];
	/** 正在流式生成的消息。 */
	streaming?: AgentMessage;
	/** 工具执行中的实时输出 (toolCallId → 文本)。 */
	readonly toolOutput = new Map<string, string>();
	notices: string[] = [];

	render(width: number): string[] {
		const lines: string[] = [];
		const all = this.streaming ? [...this.messages, this.streaming] : this.messages;
		for (const message of all) lines.push(...this.renderMessage(message, width));
		for (const notice of this.notices) lines.push(style.yellow(notice), "");
		return lines;
	}

	private renderMessage(message: AgentMessage, width: number): string[] {
		switch (message.role) {
			case "user":
				return [style.bold(style.cyan("› ")) + contentText(message.content), ""];
			case "assistant": {
				const lines: string[] = [];
				for (const block of message.content) {
					if (block.type === "thinking") lines.push(style.gray(block.thinking));
					else if (block.type === "text") lines.push(block.text);
					else {
						const args = JSON.stringify(block.arguments);
						lines.push(style.yellow(`⏺ ${block.name}`) + style.dim(` ${args.length > width - 10 ? `${args.slice(0, width - 13)}...` : args}`));
						const live = this.toolOutput.get(block.id);
						if (live) lines.push(...lastLines(live, 5).map((line) => style.dim(`  ${line}`)));
					}
				}
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					lines.push(style.red(`[${message.stopReason}] ${message.errorMessage ?? ""}`));
				}
				lines.push("");
				return lines;
			}
			case "toolResult": {
				const text = contentText(message.content).trimEnd();
				const color = message.isError ? style.red : style.dim;
				return [...lastLines(text, 6).map((line) => color(`  ⎿ ${line}`)), ""];
			}
			case "summary":
				return [style.gray(`[${message.kind} summary]`), ...lastLines(message.summary, 4).map(style.gray), ""];
			case "custom":
				return message.display ? [style.gray(`[${message.customType}] ${message.content}`), ""] : [];
		}
	}
}

function lastLines(text: string, count: number): string[] {
	const lines = text.split("\n");
	if (lines.length <= count) return lines;
	return [`… ${lines.length - count} more lines`, ...lines.slice(-count)];
}

/** 输入框：多行文本，光标固定在末尾 (简化)。 */
export class Editor implements Component {
	text = "";
	prompt = "> ";
	/** 有值时编辑器处于"回答问题"状态 (扩展的 confirm/select/input)。 */
	question?: string;

	render(width: number): string[] {
		const border = style.gray("─".repeat(width));
		const header = this.question ? [style.yellow(this.question)] : [];
		const body = this.text.split("\n").map((line, index) => (index === 0 ? this.prompt : "  ") + line);
		body[body.length - 1] += "\x1b[7m \x1b[27m"; // 反色方块当光标
		return [border, ...header, ...body, border];
	}
}

/** 状态栏：模型、上下文占用、运行状态。 */
export class Footer implements Component {
	model = "";
	usage = "";
	status = "";

	render(): string[] {
		return [style.gray([this.model, this.usage, this.status].filter(Boolean).join("  ·  "))];
	}
}
