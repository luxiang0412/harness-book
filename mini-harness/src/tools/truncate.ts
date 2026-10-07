/**
 * 第 3 章：工具输出截断。
 *
 * 对应 pi 的 packages/coding-agent/src/core/tools/truncate.ts。
 *
 * 工具输出原样塞进上下文会出两类问题：
 * - `cat` 一个 5MB 的日志，直接撑爆上下文窗口；
 * - 即使没撑爆，大段无关输出也会稀释模型的注意力，并且每一轮都要重新付费。
 *
 * 两个独立上限，先到先生效：行数 (2000) 和字节数 (50KB)。
 * - 读文件用 head 截断：开头最重要，并告诉模型用 offset 继续读；
 * - 命令输出用 tail 截断：错误和结论通常在最后。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	outputLines: number;
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf-8");

/** 保留开头。不会返回半行。 */
export function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
	const lines = splitLines(content);
	if (lines.length <= maxLines && byteLength(content) <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines: lines.length, outputLines: lines.length };
	}
	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (const line of lines) {
		if (kept.length >= maxLines) break;
		const lineBytes = byteLength(line) + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}
	return { content: kept.join("\n"), truncated: true, truncatedBy, totalLines: lines.length, outputLines: kept.length };
}

/** 保留结尾。 */
export function truncateTail(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
	const lines = splitLines(content);
	if (lines.length <= maxLines && byteLength(content) <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines: lines.length, outputLines: lines.length };
	}
	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = lines.length - 1; i >= 0; i--) {
		if (kept.length >= maxLines) break;
		const lineBytes = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 最后一行本身就超长：保留它的结尾部分。
			if (kept.length === 0) kept.unshift(lines[i].slice(-maxBytes));
			break;
		}
		kept.unshift(lines[i]);
		bytes += lineBytes;
	}
	return { content: kept.join("\n"), truncated: true, truncatedBy, totalLines: lines.length, outputLines: kept.length };
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
