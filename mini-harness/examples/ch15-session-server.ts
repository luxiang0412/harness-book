/**
 * 第 15 章示例：会话服务器。
 *
 * 把 AgentSession 放进一个长期运行的服务器进程，客户端通过 Unix socket 连接。
 * 多个客户端可以 attach 到同一个会话：一个发 prompt，所有客户端都收到事件。
 * 客户端断开，会话继续运行。
 *
 * 对应 pi 的 packages/protocol (帧格式)、packages/server (路由、attach)、packages/client。
 * pi 用 CBOR 编码、带版本握手和 serverId 校验；这里用 JSON，只保留结构。
 *
 *   node examples/ch15-session-server.ts      # 在同一个进程里启动服务器和两个客户端，演示完整流程
 *
 * 帧格式：4 字节大端长度 + JSON。
 * 为什么不用换行分隔？长度前缀不需要转义，也不需要扫描内容找分隔符，二进制数据 (pi 的 CBOR) 也能直接传。
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxModel } from "../src/ai/faux.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { SessionManager } from "../src/session/session-manager.ts";

// ---------- 帧编解码 ----------

function encodeFrame(message: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
}

/** 处理任意切分和粘连：一个 data 事件里可能有半帧，也可能有好几帧。 */
function createFrameDecoder(onMessage: (message: any) => void, maxFrame = 16 * 1024 * 1024) {
	let buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (length > maxFrame) throw new Error(`Frame too large: ${length}`);
			if (buffer.length < 4 + length) break;
			onMessage(JSON.parse(buffer.subarray(4, 4 + length).toString("utf-8")));
			buffer = buffer.subarray(4 + length);
		}
	};
}

// ---------- 服务器 ----------

const PROTOCOL_VERSION = 1;

interface HostedSession {
	session: AgentSession;
	/** attachmentId → 连接。一个会话可以被多个客户端同时查看。 */
	attachments: Map<string, Socket>;
}

export function startServer(socketPath: string, createSession: () => AgentSession) {
	const sessions = new Map<string, HostedSession>();

	const server = createServer((socket) => {
		const send = (message: unknown) => socket.write(encodeFrame(message));
		let greeted = false;
		const myAttachments = new Set<string>();

		socket.on(
			"data",
			createFrameDecoder(async (message) => {
				// 1. 握手：协议版本不匹配就拒绝，避免新旧客户端互相误解。
				if (!greeted) {
					if (message.type !== "hello" || message.version !== PROTOCOL_VERSION) {
						send({ type: "error", error: "Expected hello with protocol version 1" });
						socket.end();
						return;
					}
					greeted = true;
					send({ type: "hello_ok", version: PROTOCOL_VERSION });
					return;
				}

				// 2. attach：创建或加入会话。服务器生成 attachmentId，之后的请求都要带上它。
				if (message.type === "attach") {
					const sessionId: string = message.sessionId ?? randomUUID();
					let hosted = sessions.get(sessionId);
					if (!hosted) {
						const session = createSession();
						hosted = { session, attachments: new Map() };
						sessions.set(sessionId, hosted);
						const target = hosted;
						// 事件扇出：会话的每个事件发给所有 attach 的客户端。
						session.subscribe((event) => {
							for (const peer of target.attachments.values()) peer.write(encodeFrame({ type: "event", sessionId, event }));
						});
					}
					const attachmentId = randomUUID();
					hosted.attachments.set(attachmentId, socket);
					myAttachments.add(attachmentId);
					// 新加入的客户端先拿到完整快照，再接收增量事件。
					send({ type: "attached", requestId: message.requestId, sessionId, attachmentId, snapshot: hosted.session.messages });
					return;
				}

				// 3. 请求：校验路由 (会话存在、attachment 属于这个连接)，再转给 AgentSession。
				if (message.type === "request") {
					const { id, target, method, params } = message;
					const hosted = sessions.get(target?.sessionId);
					if (!hosted || hosted.attachments.get(target.attachmentId) !== socket) {
						send({ type: "response", id, ok: false, error: "Stale or unknown session route" });
						return;
					}
					try {
						let result: unknown;
						if (method === "prompt") {
							// 和 RPC 模式一样：响应只表示"已接受"。
							void hosted.session.prompt(params.text);
						} else if (method === "abort") {
							hosted.session.abort();
						} else if (method === "get_state") {
							result = { isRunning: hosted.session.agent.state.isRunning, messages: hosted.session.messages.length };
						} else {
							throw new Error(`Unknown method ${method}`);
						}
						send({ type: "response", id, ok: true, result });
					} catch (error) {
						send({ type: "response", id, ok: false, error: String(error) });
					}
				}
			}),
		);

		// 4. 断开：只释放这个连接的 attachment。会话本身继续运行。
		socket.on("close", () => {
			for (const hosted of sessions.values()) {
				for (const attachmentId of myAttachments) hosted.attachments.delete(attachmentId);
			}
		});
	});

	return new Promise<{ close: () => void }>((resolve) => {
		server.listen(socketPath, () => resolve({ close: () => server.close() }));
	});
}

// ---------- 客户端 ----------

export async function connectClient(socketPath: string, name: string) {
	const socket = createConnection(socketPath);
	const pending = new Map<string, (message: any) => void>();
	const eventListeners: ((event: any) => void)[] = [];
	let nextId = 0;

	socket.on(
		"data",
		createFrameDecoder((message) => {
			if (message.type === "event") for (const listener of eventListeners) listener(message.event);
			const key = message.type === "response" ? message.id : message.requestId ?? message.type;
			const resolve = pending.get(key);
			if (resolve) {
				pending.delete(key);
				resolve(message);
			}
		}),
	);
	const call = (message: Record<string, unknown>, key: string) =>
		new Promise<any>((resolve) => {
			pending.set(key, resolve);
			socket.write(encodeFrame(message));
		});

	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	await call({ type: "hello", version: PROTOCOL_VERSION }, "hello_ok");

	let route: { sessionId: string; attachmentId: string } | undefined;
	return {
		name,
		onEvent: (listener: (event: any) => void) => eventListeners.push(listener),
		async attach(sessionId?: string) {
			const requestId = `${name}-attach-${nextId++}`;
			const reply = await call({ type: "attach", sessionId, requestId }, requestId);
			route = { sessionId: reply.sessionId, attachmentId: reply.attachmentId };
			return reply;
		},
		request(method: string, params?: unknown) {
			const id = `${name}-${nextId++}`;
			return call({ type: "request", id, target: route, method, params }, id);
		},
		close: () => socket.end(),
	};
}

// ---------- 演示 ----------

if (import.meta.url === `file://${process.argv[1]}`) {
	const dir = mkdtempSync(join(tmpdir(), "mini-server-"));
	const socketPath = join(dir, "mini.sock");
	const faux = createFauxModel(["Hello from the shared session.", "Still running after a client left."]);
	const server = await startServer(socketPath, () => new AgentSession({ cwd: dir, model: faux.model, sessionManager: SessionManager.inMemory(dir), tools: [] }));

	const alice = await connectClient(socketPath, "alice");
	const bob = await connectClient(socketPath, "bob");
	for (const client of [alice, bob]) {
		client.onEvent((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				console.log(`[${client.name}] assistant: ${event.message.content[0]?.text}`);
			}
		});
	}

	const { sessionId } = await alice.attach(); // alice 创建会话
	const bobAttach = await bob.attach(sessionId); // bob 加入同一个会话
	console.log(`bob attached; snapshot has ${bobAttach.snapshot.length} messages`);

	const ended = new Promise<void>((resolve) => alice.onEvent((event) => event.type === "agent_end" && resolve()));
	console.log("alice prompt →", (await alice.request("prompt", { text: "hi" })).ok);
	await ended;

	bob.close(); // bob 离开，会话不受影响
	const ended2 = new Promise<void>((resolve) => alice.onEvent((event) => event.type === "agent_end" && resolve()));
	await alice.request("prompt", { text: "are you still there?" });
	await ended2;
	console.log("state:", (await alice.request("get_state")).result);

	alice.close();
	server.close();
}
