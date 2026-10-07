/**
 * 第 8 章：终端文本宽度与换行。
 *
 * 终端按"列"排版，不是按字符：
 * - ANSI 转义序列 (颜色) 不占列；
 * - 中文、日文等全角字符占 2 列。
 * 算错宽度会让换行错位，进而让差分渲染的行号全部对不上。
 * pi 的实现见 packages/tui/src/utils.ts (visibleWidth 等)。
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function isWide(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	);
}

export function charWidth(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (codePoint < 0x20) return 0;
	return isWide(codePoint) ? 2 : 1;
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) width += charWidth(char);
	return width;
}

/**
 * 按列宽折行。ANSI 序列原样保留但不计宽度。
 * 简化：不跨行延续颜色 (pi 会在每行开头重新应用当前样式)。
 */
export function wrapLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	const result: string[] = [];
	let current = "";
	let currentWidth = 0;
	let index = 0;
	while (index < line.length) {
		ANSI.lastIndex = index;
		const match = ANSI.exec(line);
		if (match && match.index === index) {
			current += match[0];
			index += match[0].length;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index) ?? 0);
		const w = charWidth(char);
		if (currentWidth + w > width) {
			result.push(current);
			current = "";
			currentWidth = 0;
		}
		current += char;
		currentWidth += w;
		index += char.length;
	}
	result.push(current);
	return result;
}

export function wrapText(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => wrapLine(line, width));
}

export const style = {
	dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
	green: (text: string) => `\x1b[32m${text}\x1b[39m`,
	yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
	red: (text: string) => `\x1b[31m${text}\x1b[39m`,
	gray: (text: string) => `\x1b[90m${text}\x1b[39m`,
};
