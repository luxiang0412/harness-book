/**
 * 第 8 章：差分渲染的终端 UI。
 *
 * 对应 pi 的 packages/tui/src/tui-main-screen.ts。
 *
 * 组件模型极简：每个组件只实现 render(width) → string[]，一行一个字符串。
 * TUI 把所有组件的行拼起来，和上一帧比较，只重写变化的部分。
 *
 * 为什么要差分？流式输出时每秒可能刷新几十次。如果每次都清屏重画：
 * - 屏幕闪烁；
 * - 长对话每帧要写几万个字符，终端跟不上。
 *
 * 算法 (主屏幕模式，保留终端自己的滚动历史)：
 *
 *   上一帧: A B C D E          新一帧: A B C D' E F
 *                                         ↑ firstChanged = 3
 *   1. 光标从最后一行 (E) 上移到第 3 行
 *   2. 清除光标以下的全部内容 (ESC[J)
 *   3. 写出 D' E F
 *
 * 如果 firstChanged 已经滚出了屏幕顶部，光标到不了那里，只能整体重画。
 * 所以 UI 应该让"会变化的内容"尽量靠近底部 (输入框、状态栏、正在流式输出的消息)。
 */

import { wrapText } from "./text.ts";

export interface Component {
	render(width: number): string[];
}

export interface Terminal {
	columns: number;
	rows: number;
	write(data: string): void;
}

export class TUI {
	private readonly terminal: Terminal;
	private readonly children: Component[] = [];
	private previousLines: string[] = [];
	private previousWidth = 0;
	private renderScheduled = false;
	private stopped = false;
	/** 用于测试和调试：完整重画的次数。 */
	fullRedraws = 0;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	/** 合并同一时刻的多次刷新请求：100 个 delta 事件只触发一次渲染。 */
	requestRender(): void {
		if (this.renderScheduled || this.stopped) return;
		this.renderScheduled = true;
		setImmediate(() => {
			this.renderScheduled = false;
			this.render();
		});
	}

	render(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		// 每行都按宽度折好，保证"一个字符串 = 屏幕上一行"，行号才可靠。
		const lines = this.children.flatMap((child) => child.render(width)).flatMap((line) => wrapText(line, width));

		if (width !== this.previousWidth) {
			// 宽度变了，所有折行都变了，只能重画。
			this.fullRender(lines, this.previousLines.length > 0);
			return;
		}

		let firstChanged = -1;
		const max = Math.max(lines.length, this.previousLines.length);
		for (let i = 0; i < max; i++) {
			if (lines[i] !== this.previousLines[i]) {
				firstChanged = i;
				break;
			}
		}
		if (firstChanged === -1) return;

		const viewportTop = Math.max(0, this.previousLines.length - this.terminal.rows);
		if (firstChanged < viewportTop) {
			this.fullRender(lines, true);
			return;
		}

		// 光标总是停在上一帧最后一行的末尾。
		const cursorRow = this.previousLines.length - 1;
		let out = "\x1b[?2026h"; // 同步输出开始：终端攒齐这一帧再显示，避免闪烁
		if (firstChanged > cursorRow) {
			// 纯追加：换行后接着写。
			out += `\r\n${lines.slice(firstChanged).join("\r\n")}`;
		} else {
			// 内容变短时，从新内容的最后一行开始重写，把多余的旧行清掉。
			const start = Math.max(0, Math.min(firstChanged, lines.length - 1));
			const up = cursorRow - start;
			if (up > 0) out += `\x1b[${up}A`;
			out += "\r\x1b[J"; // 回到行首，清除光标及以下
			out += lines.slice(start).join("\r\n");
		}
		out += "\x1b[?2026l";
		this.terminal.write(out);
		this.previousLines = lines;
	}

	private fullRender(lines: string[], clear: boolean): void {
		this.fullRedraws += 1;
		let out = "\x1b[?2026h";
		if (clear) out += "\x1b[2J\x1b[H\x1b[3J"; // 清屏、光标归位、清滚动历史
		out += lines.join("\r\n");
		out += "\x1b[?2026l";
		this.terminal.write(out);
		this.previousLines = lines;
		this.previousWidth = this.terminal.columns;
	}

	stop(): void {
		this.stopped = true;
		this.terminal.write("\r\n");
	}
}
