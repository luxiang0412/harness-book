/**
 * 第 1 章：统一入口。
 *
 * 上层代码只调用 stream() / complete()，不关心底下是哪家 API。
 * pi 里这一层是 Models.stream() (packages/ai/src/models.ts)，
 * 它还负责凭据解析和按 provider 分发。
 */

import { streamAnthropic } from "./anthropic.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { streamFaux } from "./faux.ts";
import { streamOpenAI } from "./openai.ts";
import type { AssistantMessage, Context, Model, StreamOptions } from "./types.ts";

export type StreamFn = (model: Model, context: Context, options?: StreamOptions) => AssistantMessageEventStream;

export const stream: StreamFn = (model, context, options) => {
	switch (model.api) {
		case "anthropic-messages":
			return streamAnthropic(model, context, options);
		case "openai-completions":
			return streamOpenAI(model, context, options);
		case "faux":
			return streamFaux(model, context, options);
	}
};

/** 不关心中间过程时，直接等待完整结果。 */
export async function complete(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}
