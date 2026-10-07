/**
 * 第 1 章：异步事件流。
 *
 * 对应 pi 的 packages/ai/src/utils/event-stream.ts。
 *
 * 生产者调用 push() 推送事件，消费者用 `for await` 读取。
 * 流结束时还能通过 result() 拿到最终结果 (对 assistant 流来说就是完整的消息)。
 *
 *   producer: push(e1) push(e2) push(done)
 *   consumer:      for await (const e of stream) { ... }
 *                  const final = await stream.result()
 */

import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

export class EventStream<T, R> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiters: ((result: IteratorResult<T>) => void)[] = [];
	private finished = false;
	private readonly isFinal: (event: T) => boolean;
	private readonly extractResult: (event: T) => R;
	private resolveResult!: (result: R) => void;
	private readonly resultPromise: Promise<R>;

	constructor(isFinal: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isFinal = isFinal;
		this.extractResult = extractResult;
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
	}

	push(event: T): void {
		if (this.finished) return;
		if (this.isFinal(event)) {
			this.finished = true;
			this.resolveResult(this.extractResult(event));
		}
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
		// 最终事件之后，唤醒其余等待者让它们结束迭代。
		if (this.finished) {
			for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
		}
	}

	/** 不经过最终事件直接结束 (例如生产者出错)。 */
	end(result?: R): void {
		if (result !== undefined && !this.finished) this.resolveResult(result);
		this.finished = true;
		for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const next = this.queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.finished) return;
			const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
			if (result.done) return;
			yield result.value;
		}
	}

	result(): Promise<R> {
		return this.resultPromise;
	}
}

/** 一次 assistant 回复的事件流：以 done 或 error 结束，最终结果是 AssistantMessage。 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unreachable");
			},
		);
	}
}
