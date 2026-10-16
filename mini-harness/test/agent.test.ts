/**
 * 第 2–4 章的行为测试。全部使用 faux 模型，不需要网络和 API key。
 * 运行：node --test test/
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.ts";
import type { AgentEvent, AgentTool } from "../src/agent/types.ts";
import { createFauxModel, toolCall } from "../src/ai/faux.ts";
import { createCodingTools } from "../src/tools/index.ts";

const echoTool: AgentTool<{ text: string }> = {
	name: "echo",
	description: "Echo the text back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	async execute(_id, { text }) {
		return { content: [{ type: "text", text }] };
	},
};

test("text-only reply ends the run after one turn", async () => {
	const faux = createFauxModel(["Hello!"]);
	const agent = new Agent({ model: faux.model });
	const events: string[] = [];
	agent.subscribe((event) => {
		events.push(event.type);
	});
	await agent.prompt("hi");

	assert.deepEqual(
		events.filter((type) => type !== "message_update"),
		["agent_start", "turn_start", "message_start", "message_end", "message_start", "message_end", "turn_end", "agent_end"],
	);
	assert.equal(agent.state.messages.length, 2);
});

test("tool call → tool result → final answer", async () => {
	const faux = createFauxModel([[toolCall("echo", { text: "ping" })], (context) => {
		const last = context.messages.at(-1);
		assert.equal(last?.role, "toolResult");
		return "got ping";
	}]);
	const agent = new Agent({ model: faux.model, tools: [echoTool] });
	await agent.prompt("call echo");

	const roles = agent.state.messages.map((message) => message.role);
	assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);
	assert.equal(faux.remaining(), 0);
});

test("invalid arguments come back to the model as an error result", async () => {
	const faux = createFauxModel([[toolCall("echo", { wrong: 1 })], "sorry"]);
	const agent = new Agent({ model: faux.model, tools: [echoTool] });
	await agent.prompt("go");
	const result = agent.state.messages[2];
	assert.equal(result.role, "toolResult");
	assert.equal(result.role === "toolResult" && result.isError, true);
	assert.match(JSON.stringify(result), /arguments.text: required/);
});

test("malformed tool call arguments are reported, not executed as {}", async () => {
	let executed = false;
	const tool: AgentTool = { ...echoTool, parameters: { type: "object", properties: {} }, execute: async () => ((executed = true), { content: [] }) };
	const call = { ...toolCall("echo", {}), argumentsError: 'Unexpected end of JSON input\n\nReceived arguments:\n{"text":"hi' };
	const faux = createFauxModel([[call], "sorry"]);
	const agent = new Agent({ model: faux.model, tools: [tool] });
	await agent.prompt("go");
	const result = agent.state.messages[2];
	assert.equal(executed, false);
	assert.equal(result.role === "toolResult" && result.isError, true);
	assert.match(JSON.stringify(result), /Received arguments/);
});

test("beforeToolCall can block execution", async () => {
	let executed = false;
	const tool: AgentTool = { ...echoTool, execute: async () => ((executed = true), { content: [] }) };
	const faux = createFauxModel([[toolCall("echo", { text: "x" })], "ok"]);
	const agent = new Agent({
		model: faux.model,
		tools: [tool],
		beforeToolCall: async () => ({ block: true, reason: "not allowed" }),
	});
	await agent.prompt("go");
	assert.equal(executed, false);
	assert.match(JSON.stringify(agent.state.messages[2]), /not allowed/);
});

test("steering message is injected after the current tool batch", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const slowTool: AgentTool = {
		...echoTool,
		name: "slow",
		async execute() {
			await gate;
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const faux = createFauxModel([[toolCall("slow", { text: "a" })], "first answer", "second answer"]);
	const agent = new Agent({ model: faux.model, tools: [slowTool] });
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			agent.steer("also do B");
			release();
		}
	});
	await agent.prompt("do A");
	const roles = agent.state.messages.map((message) => message.role);
	// user, assistant(tool call), toolResult, user(steer), assistant
	assert.deepEqual(roles, ["user", "assistant", "toolResult", "user", "assistant"]);
	// faux 的第三步没有被用到：插话只触发了一次请求。
	assert.equal(faux.remaining(), 1);
});

test("follow-up runs after the agent would stop", async () => {
	const faux = createFauxModel(["answer 1", "answer 2"]);
	const agent = new Agent({ model: faux.model });
	agent.followUp("and then?");
	await agent.prompt("start");
	assert.equal(agent.state.messages.filter((message) => message.role === "assistant").length, 2);
});

test("abort stops the stream and records an aborted message", async () => {
	const faux = createFauxModel(["a".repeat(10_000)]);
	const agent = new Agent({ model: faux.model });
	agent.subscribe((event) => {
		if (event.type === "message_update") agent.abort();
	});
	await agent.prompt("long");
	const last = agent.state.messages.at(-1);
	assert.equal(last?.role === "assistant" && last.stopReason, "aborted");
});

test("coding tools: write, edit, read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mini-"));
	const faux = createFauxModel([
		[toolCall("write", { path: "a.txt", content: "hello world\n" })],
		[toolCall("edit", { path: "a.txt", edits: [{ oldText: "world", newText: "harness" }] })],
		[toolCall("read", { path: "a.txt" })],
		"done",
	]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("go");
	assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "hello harness\n");
	const readResult = agent.state.messages.filter((message) => message.role === "toolResult").at(-1);
	assert.match(JSON.stringify(readResult), /hello harness/);
});

test("parallel edits to the same file do not lose updates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mini-"));
	await writeFile(join(dir, "b.txt"), "one\ntwo\n");
	const faux = createFauxModel([
		[
			toolCall("edit", { path: "b.txt", edits: [{ oldText: "one", newText: "ONE" }] }),
			toolCall("edit", { path: "b.txt", edits: [{ oldText: "two", newText: "TWO" }] }),
		],
		"done",
	]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("go");
	assert.equal(await readFile(join(dir, "b.txt"), "utf-8"), "ONE\nTWO\n");
});

test("bash returns isError on non-zero exit code", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mini-"));
	const faux = createFauxModel([[toolCall("bash", { command: "echo out; exit 3" })], "ok"]);
	const agent = new Agent({ model: faux.model, tools: createCodingTools(dir) });
	await agent.prompt("go");
	const result = agent.state.messages[2];
	assert.equal(result.role === "toolResult" && result.isError, true);
	assert.match(JSON.stringify(result), /exited with code 3/);
});
