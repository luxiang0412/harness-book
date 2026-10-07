/**
 * 第 9 章：事件的线上格式。
 *
 * 对应 pi 的 packages/coding-agent/src/modes/json-event.ts。
 *
 * 内存里的 message_update 事件带着完整的 partial 消息 (到目前为止的全部内容)。
 * 原样序列化的话，一条 1000 个增量的回复会输出 1 + 2 + … + 1000 份内容，
 * 总量和长度的平方成正比。线上只发增量；message_start 给出初始消息，message_end 给出最终消息。
 */

import type { SessionEvent } from "../session/agent-session.ts";

export function toJsonEvent(event: SessionEvent): unknown {
	if (event.type !== "message_update") return event;
	const { partial: _partial, ...delta } = event.event as typeof event.event & { partial?: unknown };
	return { type: "message_update", event: delta };
}
