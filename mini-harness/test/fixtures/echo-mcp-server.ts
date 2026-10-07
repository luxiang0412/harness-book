/**
 * 测试用的最小 MCP 服务器 (stdio)。提供 echo 和 add 两个工具。
 * 也可以作为写 MCP 服务器的参考：本质上就是按行读 JSON-RPC、按行写回。
 */

import { createInterface } from "node:readline";

const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const tools = [
	{
		name: "echo",
		description: "Echo back the given text",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{
		name: "add",
		description: "Add two numbers",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	},
];

// 测试夹具里输入是可信的，用 readline 足够；生产代码应按 \n 自行切分 (见 rpc.ts 的说明)。
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line) as { id?: number; method: string; params?: any };
	if (message.id === undefined) return; // 通知
	switch (message.method) {
		case "initialize":
			send({
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "echo-server", version: "1.0.0" },
					instructions: "Test server with echo and add.",
				},
			});
			break;
		case "tools/list":
			send({ id: message.id, result: { tools } });
			break;
		case "tools/call": {
			const { name, arguments: args } = message.params;
			if (name === "echo") send({ id: message.id, result: { content: [{ type: "text", text: args.text }] } });
			else if (name === "add") send({ id: message.id, result: { content: [{ type: "text", text: String(args.a + args.b) }] } });
			else send({ id: message.id, result: { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true } });
			break;
		}
		default:
			send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
});
