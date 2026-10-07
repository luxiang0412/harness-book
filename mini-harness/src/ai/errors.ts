/**
 * 第 4 章 / 第 7 章：错误分类。
 *
 * 对应 pi 的 packages/ai/src/utils/overflow.ts 和 retry 相关代码。
 *
 * 失败的请求要区分三类，处理方式完全不同：
 *   上下文溢出   → 压缩后重试 (重试本身没用，请求还是太大)
 *   临时错误     → 等一会儿重试 (429 限流、5xx、网络断开)
 *   其他错误     → 报告给用户 (key 无效、请求格式错误)
 *
 * 各家 provider 的溢出错误文本都不一样，只能用正则逐一匹配。
 * pi 维护了 20 多条模式，这里挑最常见的几条。
 */

import type { AssistantMessage } from "./types.ts";

const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic
	/request_too_large/i, // Anthropic 413
	/exceeds the context window/i, // OpenAI
	/maximum context length/i, // OpenAI 兼容 / OpenRouter
	/context[_ ]length[_ ]exceeded/i,
	/input token count.*exceeds the maximum/i, // Google
];

const RETRYABLE_PATTERNS = [
	/overloaded/i,
	/rate.?limit/i,
	/\b(408|409|429|500|502|503|504|529)\b/,
	/timed? ?out/i,
	/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/,
	/fetch failed|socket hang up|terminated|network/i,
];

export function isContextOverflow(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason === "error" && message.errorMessage) {
		return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message.errorMessage ?? ""));
	}
	// 有些服务不报错，而是悄悄截断输入：输入占满窗口且没有输出。
	return message.stopReason === "length" && message.usage.output === 0 && message.usage.input >= contextWindow * 0.99;
}

export function isRetryableError(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (isContextOverflow(message, contextWindow)) return false;
	return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message.errorMessage ?? ""));
}
