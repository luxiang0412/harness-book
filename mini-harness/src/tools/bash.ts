/**
 * 第 3 章：bash 工具。
 *
 * 对应 pi 的 packages/coding-agent/src/core/tools/bash.ts。
 *
 * 设计要点：
 * - stdout 和 stderr 合并，按到达顺序交给模型，和人在终端里看到的一致；
 * - 流式更新：长命令执行时，通过 onUpdate 把已有输出推给 UI；
 * - 中断和超时要杀掉整个进程树 (detached + kill(-pid))，
 *   否则 `npm test` 启动的子进程会变成孤儿继续跑；
 * - 退出码非 0 时返回 isError，并把退出码写进内容，模型据此判断成败；
 * - 输出用 tail 截断，完整输出存到临时文件，告诉模型去哪里看。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../agent/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.ts";

interface BashArgs {
	command: string;
	timeout?: number;
}

export function createBashTool(cwd: string): AgentTool<BashArgs> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		// bash 会运行任意程序，可能修改共享状态，这里让它独占执行。
		executionMode: "sequential",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Bash command to execute" },
				timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
			},
			required: ["command"],
		},
		async execute(_id, { command, timeout }, signal, onUpdate) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const chunks: Buffer[] = [];
			let lastUpdate = 0;

			const exitCode = await new Promise<number | null>((resolve, reject) => {
				const child = spawn("bash", ["-c", command], {
					cwd,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				const kill = () => {
					if (!child.pid) return;
					try {
						process.kill(-child.pid, "SIGKILL"); // 负 pid = 整个进程组
					} catch {
						child.kill("SIGKILL");
					}
				};
				const timer = timeout ? setTimeout(() => ((timedOut = true), kill()), timeout * 1000) : undefined;
				signal?.addEventListener("abort", kill, { once: true });

				const onData = (data: Buffer) => {
					chunks.push(data);
					// 节流：最多每 100ms 推一次，避免刷屏。
					const now = Date.now();
					if (now - lastUpdate > 100) {
						lastUpdate = now;
						onUpdate({ content: [{ type: "text", text: truncateTail(Buffer.concat(chunks).toString("utf-8")).content }] });
					}
				};
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", reject);
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", kill);
					if (signal?.aborted) reject(new Error("Command aborted"));
					else if (timedOut) reject(new Error(`Command timed out after ${timeout} seconds`));
					else resolve(code);
				});
			});

			const full = Buffer.concat(chunks).toString("utf-8");
			const truncation = truncateTail(full);
			let text = truncation.content || "(no output)";
			if (truncation.truncated) {
				const fullPath = join(tmpdir(), `mini-bash-${Date.now()}.log`);
				await writeFile(fullPath, full);
				const first = truncation.totalLines - truncation.outputLines + 1;
				text += `\n\n[Showing lines ${first}-${truncation.totalLines} of ${truncation.totalLines}. Full output: ${fullPath}]`;
			}
			if (exitCode !== 0) {
				return { content: [{ type: "text", text: `${text}\n\nCommand exited with code ${exitCode ?? "unknown"}` }], isError: true };
			}
			return { content: [{ type: "text", text }] };
		},
	};
}
