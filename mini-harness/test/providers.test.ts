/**
 * 第 1 章：provider 适配器测试。
 * 起一个本地 HTTP 服务器，按真实格式回放 SSE，检查适配器产生的统一事件和最终消息。
 * 不访问真实 API，不需要 key。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { stream } from "../src/ai/stream.ts";
import type { AssistantMessageEvent, Model } from "../src/ai/types.ts";

let server: Server;
let baseUrl = "";
let lastBody: Record<string, any> = {};

const anthropicSse = [
	{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 120, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"a.txt"}' } },
	{ type: "content_block_stop", index: 1 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

const openaiSse = [
	{ choices: [{ delta: { role: "assistant", content: "Sure" } }] },
	{ choices: [{ delta: { content: ", reading." } }] },
	{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }] } }] },
	{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
	{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b.txt"}' } }] } }] },
	{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
	{ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 20 } } },
]
	.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
	.join("")
	.concat("data: [DONE]\n\n");

async function readBody(request: IncomingMessage): Promise<Record<string, any>> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body) as Record<string, any>;
}

before(async () => {
	server = createServer(async (request, response) => {
		lastBody = await readBody(request);
		if (request.url === "/v1/messages" && request.headers["x-api-key"] !== "test-key") {
			response.writeHead(401).end('{"error":{"message":"invalid x-api-key"}}');
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		// 故意按很小的块发送，验证 SSE 解析器能处理任意切分。
		const payload = request.url === "/v1/messages" ? anthropicSse : openaiSse;
		for (let i = 0; i < payload.length; i += 7) response.write(payload.slice(i, i + 7));
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function model(api: Model["api"], path: string): Model {
	return { id: "test", name: "test", api, provider: "test", baseUrl: baseUrl + path, contextWindow: 100_000, maxTokens: 1000, reasoning: false };
}

test("anthropic adapter: text + streamed tool call arguments", async () => {
	const events: AssistantMessageEvent["type"][] = [];
	const response = stream(
		model("anthropic-messages", ""),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
		},
		{ apiKey: "test-key" },
	);
	for await (const event of response) events.push(event.type);
	const message = await response.result();

	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content[0], { type: "text", text: "Let me check." });
	assert.deepEqual(message.content[1], { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } });
	assert.equal(message.usage.cacheRead, 100);
	assert.equal(events[0], "start");
	assert.equal(events.at(-1), "done");
	// 请求格式：system 带缓存标记，工具用 input_schema
	assert.equal(lastBody.system[0].cache_control.type, "ephemeral");
	assert.ok(lastBody.tools[0].input_schema);
});

test("anthropic adapter: HTTP errors become an error event, never a throw", async () => {
	const response = stream(model("anthropic-messages", ""), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "wrong" });
	const message = await response.result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /401/);
});

test("openai adapter: tool call fragments are reassembled by index", async () => {
	const response = stream(
		model("openai-completions", "/v1"),
		{
			messages: [
				{ role: "user", content: "hi", timestamp: 0 },
				// 一条历史 tool call + 结果，检查转换后的 tool 角色消息
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: "x" } }],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason: "toolUse",
					timestamp: 0,
				},
				{ role: "toolResult", toolCallId: "c0", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 0 },
			],
		},
		{ apiKey: "k" },
	);
	const message = await response.result();
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content[0], { type: "text", text: "Sure, reading." });
	assert.deepEqual(message.content[1], { type: "toolCall", id: "call_1", name: "read", arguments: { path: "b.txt" } });
	assert.equal(message.usage.cacheRead, 20);
	assert.equal(message.usage.input, 30);
	assert.equal(lastBody.messages[2].role, "tool");
	assert.equal(lastBody.messages[2].tool_call_id, "c0");
});

test("orphaned tool calls get a synthetic result before sending", async () => {
	await stream(
		model("openai-completions", "/v1"),
		{
			messages: [
				{ role: "user", content: "hi", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "orphan", name: "bash", arguments: {} }],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason: "toolUse",
					timestamp: 0,
				},
				{ role: "user", content: "never mind", timestamp: 0 },
			],
		},
		{ apiKey: "k" },
	).result();
	const roles = lastBody.messages.map((message: { role: string }) => message.role);
	assert.deepEqual(roles, ["user", "assistant", "tool", "user"]);
	assert.equal(lastBody.messages[2].content, "No result provided");
});
