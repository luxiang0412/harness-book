/**
 * 第 1 章：Server-Sent Events 解析。
 *
 * Anthropic 和 OpenAI 的流式接口都使用 SSE：
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
 *
 *   data: {"choices":[{"delta":{"content":"Hi"}}]}
 *
 * 每个事件由若干 "字段: 值" 行组成，事件之间用空行分隔。
 * 网络数据块的边界和事件边界无关，所以要先缓存，再按空行切分。
 */

export interface ServerSentEvent {
	event?: string;
	data: string;
}

export async function* iterateSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const parsed = parseEvent(raw);
				if (parsed) yield parsed;
				boundary = buffer.indexOf("\n\n");
			}
		}
		const tail = parseEvent(buffer);
		if (tail) yield tail;
	} finally {
		// 正常结束时 cancel 是空操作；提前退出 (中断、异常) 时它会关闭底层连接。
		await reader.cancel().catch(() => {});
	}
}

function parseEvent(raw: string): ServerSentEvent | undefined {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue; // 注释行，常用作 keep-alive
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const field = line.slice(0, colon);
		const value = line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return undefined;
	return { event, data: data.join("\n") };
}

/**
 * 流式 tool call 参数是逐段到达的 JSON 片段。
 * 流结束前它通常不是合法 JSON，解析失败时返回空对象。
 * pi 用 partial-json 库做"尽量解析"，以便 UI 实时显示参数，这里简化处理。
 */
export function parseToolArguments(json: string): Record<string, unknown> {
	if (!json.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(json);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
