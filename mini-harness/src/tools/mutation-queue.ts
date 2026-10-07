/**
 * 第 3 章：同一文件的修改排队执行。
 *
 * 对应 pi 的 packages/coding-agent/src/core/tools/file-mutation-queue.ts。
 *
 * 问题：模型在一条回复里发出两个 edit，都改 a.ts。并行执行时：
 *
 *   edit#1 读 a.ts (v0) ─┐
 *   edit#2 读 a.ts (v0) ─┤  两者都基于 v0 修改
 *   edit#1 写 a.ts (v1) ─┤
 *   edit#2 写 a.ts (v2) ─┘  v2 覆盖了 v1，第一处修改丢失
 *
 * 解决：按文件路径串行化，不同文件之间仍然并行。
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();
/**
 * 计算 key 需要异步的 realpath。为了让排队顺序等于调用顺序，
 * "登记"这一步本身也串行执行。
 */
let registration: Promise<unknown> = Promise.resolve();

async function queueKey(path: string): Promise<string> {
	const absolute = resolve(path);
	// 用真实路径做 key，避免通过符号链接绕过排队。文件不存在时用原路径。
	return realpath(absolute).catch(() => absolute);
}

export async function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const registered = registration.then(async () => {
		const key = await queueKey(path);
		const previous = queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveCurrent) => {
			release = resolveCurrent;
		});
		const chained = previous.then(() => current);
		queues.set(key, chained);
		return { key, previous, chained, release };
	});
	registration = registered.catch(() => undefined);
	const { key, previous, chained, release } = await registered;

	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (queues.get(key) === chained) queues.delete(key);
	}
}
