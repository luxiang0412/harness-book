/**
 * 第 12 章：最小 MCP 客户端 (stdio 传输)。
 *
 * 对应 pi 的 packages/mcp/src/client.ts 和 transports/stdio.ts。
 *
 * MCP = JSON-RPC 2.0 + 一组约定的方法。stdio 传输下，
 * 每条消息是一行 JSON，客户端写服务器的 stdin，读服务器的 stdout。
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":…,"capabilities":…}}
 *   → {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   ← {"jsonrpc":"2.0","id":2,"result":{"tools":[…]}}
 *   → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{…}}}
 *
 * 三种消息：带 id 的请求 (需要响应)、不带 id 的通知、带 id 的响应。
 * 服务器也可以向客户端发请求 (例如 ping、roots/list)，客户端必须回应。
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { JsonSchema } from "../ai/types.ts";

export const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: JsonSchema;
}

export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
}

export interface McpCallResult {
	content: McpContent[];
	isError?: boolean;
}

export interface StdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class McpClient {
	private readonly child: ChildProcess;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = "";
	private closed = false;
	stderr = "";
	instructions?: string;

	private constructor(child: ChildProcess) {
		this.child = child;
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => this.onData(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			// 只保留尾部，用于报错时展示。
			this.stderr = (this.stderr + chunk.toString()).slice(-4000);
		});
		child.on("exit", () => this.failAll(new Error(`MCP server exited. stderr: ${this.stderr.trim()}`)));
		child.on("error", (error) => this.failAll(error));
	}

	static async connectStdio(config: StdioServerConfig, clientInfo = { name: "mini-harness", version: "0.1.0" }): Promise<McpClient> {
		const child = spawn(config.command, config.args ?? [], {
			cwd: config.cwd,
			env: { ...process.env, ...config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new McpClient(child);
		try {
			const result = (await client.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo,
			})) as { protocolVersion: string; instructions?: string };
			client.instructions = result.instructions;
			client.notify("notifications/initialized");
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	private write(message: Record<string, unknown>): void {
		this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP connection closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, ...(params ? { params } : {}) });
		});
	}

	notify(method: string, params?: Record<string, unknown>): void {
		this.write({ method, ...(params ? { params } : {}) });
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) continue;
			let message: Record<string, any>;
			try {
				message = JSON.parse(line) as Record<string, any>;
			} catch {
				continue; // 有些服务器会往 stdout 打日志，忽略非 JSON 行
			}
			this.onMessage(message);
		}
	}

	private onMessage(message: Record<string, any>): void {
		// 响应
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
			else pending.resolve(message.result);
			return;
		}
		// 服务器发来的请求：支持 ping，其余回 "method not found"。
		if (message.id !== undefined && message.method) {
			if (message.method === "ping") this.write({ id: message.id, result: {} });
			else this.write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
		}
		// 通知 (例如 notifications/tools/list_changed) 这里不处理。
	}

	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const result = (await this.request("tools/list", cursor ? { cursor } : undefined)) as { tools: McpTool[]; nextCursor?: string };
			tools.push(...result.tools);
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		const call = this.request("tools/call", { name, arguments: args }) as Promise<McpCallResult>;
		if (!signal) return call;
		return Promise.race([
			call,
			new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true })),
		]);
	}

	private failAll(error: Error): void {
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin?.end();
		this.child.kill("SIGTERM");
	}
}
