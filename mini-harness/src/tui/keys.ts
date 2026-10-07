/**
 * 第 8 章：按键解析与可配置的快捷键。
 *
 * 终端在 raw 模式下把按键编码成字节序列：
 *   Enter = "\r"   Backspace = "\x7f"   Ctrl+C = "\x03"   Esc = "\x1b"
 *   Alt+Enter = "\x1b\r"   方向键上 = "\x1b[A"
 *
 * pi 的规则：代码里不写死按键判断，而是查"动作 → 按键"表 (DEFAULT_EDITOR_KEYBINDINGS)，
 * 用户可以在配置文件里改。这里用同样的结构。
 */

export type KeyAction = "submit" | "newline" | "followUp" | "backspace" | "abort" | "exit" | "clearLine";

export const DEFAULT_KEYBINDINGS: Record<KeyAction, string[]> = {
	submit: ["\r"],
	newline: ["\n"], // Ctrl+J
	followUp: ["\x1b\r"], // Alt+Enter
	backspace: ["\x7f", "\b"],
	abort: ["\x1b"], // Esc
	exit: ["\x03"], // Ctrl+C
	clearLine: ["\x15"], // Ctrl+U
};

export function matchAction(data: string, bindings: Record<KeyAction, string[]> = DEFAULT_KEYBINDINGS): KeyAction | undefined {
	for (const [action, keys] of Object.entries(bindings) as [KeyAction, string[]][]) {
		if (keys.includes(data)) return action;
	}
	return undefined;
}

/** 可打印的输入 (包括粘贴的多字符文本)，过滤掉其余控制序列。 */
export function printable(data: string): string {
	if (data.startsWith("\x1b")) return "";
	return data.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}
