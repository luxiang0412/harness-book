/**
 * 第 8、9、12、13、16、17 章的测试。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "../src/agent/types.ts";
import { createFauxModel, toolCall } from "../src/ai/faux.ts";
import { createCodeModeTool } from "../src/codemode/codemode.ts";
import { recoverInterruptedToolCalls, TOOL_INTENT } from "../src/durable/recovery.ts";
import { loadMcpTools } from "../src/mcp/bridge.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { SessionManager } from "../src/session/session-manager.ts";
import { createCodingTools } from "../src/tools/index.ts";
import { resolveProjectTrust, saveTrust } from "../src/trust.ts";
import { visibleWidth, wrapLine } from "../src/tui/text.ts";
import { TUI } from "../src/tui/tui.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "mini-"));

test("tui: CJK width and differential rendering", () => {
	assert.equal(visibleWidth("中文ab"), 6);
	assert.deepEqual(wrapLine("中文中文", 5), ["中文", "中文"]);

	let written = "";
	const terminal = { columns: 20, rows: 10, write: (data: string) => void (written += data) };
	const tui = new TUI(terminal);
	const lines = ["header", "body", "footer"];
	tui.addChild({ render: () => lines });
	tui.render();
	assert.equal(tui.fullRedraws, 1);
	written = "";
	lines[2] = "footer!";
	tui.render();
	// 只重写了最后一行：上移 0 行，清除，写 "footer!"
	assert.equal(tui.fullRedraws, 1);
	assert.ok(written.includes("footer!"));
	assert.ok(!written.includes("header"));
});

test("mcp: stdio server tools become agent tools", async () => {
	const dir = tmp();
	const config = join(dir, "mcp.json");
	writeFileSync(
		config,
		JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(here, "fixtures", "echo-mcp-server.ts")] } } }),
	);
	const mcp = await loadMcpTools([config]);
	try {
		assert.deepEqual(mcp.errors, []);
		assert.deepEqual(mcp.tools.map((tool) => tool.name).sort(), ["mcp__demo__add", "mcp__demo__echo"]);
		const faux = createFauxModel([[toolCall("mcp__demo__add", { a: 2, b: 3 })], "five"]);
		const session = new AgentSession({ cwd: dir, model: faux.model, sessionManager: SessionManager.inMemory(dir), tools: mcp.tools });
		await session.prompt("add");
		const result = session.messages.find((message) => message.role === "toolResult");
		assert.match(JSON.stringify(result), /"text":"5"/);
	} finally {
		await mcp.close();
	}
});

test("trust: saved decision applies to subfolders; no protected resources means no prompt", async () => {
	const agentDir = tmp();
	const project = tmp();
	assert.equal(await resolveProjectTrust({ agentDir, cwd: project, defaultTrust: "ask", ask: async () => assert.fail("should not ask") }), false);
	mkdirSync(join(project, "sub", ".mini", "extensions"), { recursive: true });
	saveTrust(agentDir, project, true);
	assert.equal(await resolveProjectTrust({ agentDir, cwd: join(project, "sub"), defaultTrust: "ask" }), true);
	assert.equal(await resolveProjectTrust({ agentDir, cwd: join(project, "sub"), defaultTrust: "ask", override: false }), false);
});

test("codemode: script calls tools; only its output reaches the model", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "a.txt"), "alpha");
	writeFileSync(join(dir, "b.txt"), "beta");
	const tools = createCodingTools(dir);
	const codemode = createCodeModeTool({ getTools: () => tools });
	const result = await codemode.execute(
		"cm1",
		{
			code: `const names = ["a.txt", "b.txt"];
const contents = await Promise.all(names.map((path) => tools.read({ path })));
text(contents.map((c) => c.length).join(","));
return "ok";`,
		},
		undefined,
		() => {},
	);
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].type === "text" && result.content[0].text, "5,4\nok");
	assert.deepEqual(result.details, { calls: ["read", "read"] });
});

test("codemode: beforeToolCall hooks apply inside scripts", async () => {
	const tools = createCodingTools(tmp());
	const codemode = createCodeModeTool({ getTools: () => tools, beforeToolCall: async () => ({ block: true, reason: "denied" }) });
	const result = await codemode.execute("cm2", { code: `await tools.bash({ command: "echo hi" });` }, undefined, () => {});
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /denied/);
});

test("durable: interrupted tool calls are rerun only when safe", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "go", timestamp: 1 });
	const sendEmail = toolCall("send_email", { to: "a@b.c" });
	const readFile = toolCall("lookup", { key: "x" });
	session.appendMessage({
		role: "assistant",
		content: [sendEmail, readFile],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
		timestamp: 2,
	});
	// 模拟崩溃：send_email 已登记意图但没有结果；lookup 从未开始。
	session.appendCustom(TOOL_INTENT, { toolCallId: sendEmail.id, name: "send_email" });

	let emails = 0;
	const tools: (AgentTool & { replay?: "safe" | "never" })[] = [
		{ name: "send_email", description: "", parameters: { type: "object" }, execute: async () => ((emails += 1), { content: [] }) },
		{ name: "lookup", description: "", parameters: { type: "object" }, replay: "safe", execute: async () => ({ content: [{ type: "text", text: "42" }] }) },
	];
	const report = await recoverInterruptedToolCalls(session, tools);
	assert.deepEqual(report, { rerun: [readFile.id], interrupted: [sendEmail.id] });
	assert.equal(emails, 0);
	const last = session.buildContext().messages.at(-1);
	assert.equal(last?.role, "toolResult");
});

test("rpc mode: prompt is acknowledged, then events stream until agent_end", async () => {
	const child = spawn(process.execPath, [join(here, "..", "src", "main.ts"), "--mode", "rpc", "--demo", "--no-session", "--no-approve"], {
		cwd: tmp(),
		env: { ...process.env, MINI_HOME: tmp() },
	});
	const records: Record<string, unknown>[] = [];
	let buffer = "";
	const done = new Promise<void>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const record = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
				records.push(record);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (record.type === "agent_end") resolve();
			}
		});
	});
	child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "hello" })}\n`);
	await done;
	child.stdin.end();
	await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(records[0].type === "agent_start" || records[0].type === "response", true);
	assert.ok(records.some((record) => record.type === "response" && record.id === "1" && record.success === true));
	const end = records.find((record) => record.type === "agent_end") as { messages: { role: string; content: { text?: string }[] }[] };
	assert.match(JSON.stringify(end.messages), /You said: hello/);
});

test("session server: two clients share one session; session survives a disconnect", async () => {
	const child = spawn(process.execPath, [join(here, "..", "examples", "ch15-session-server.ts")]);
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	await new Promise((resolve) => child.on("exit", resolve));
	assert.match(output, /\[alice\] assistant: Hello from the shared session\./);
	assert.match(output, /\[bob\] assistant: Hello from the shared session\./);
	assert.match(output, /\[alice\] assistant: Still running after a client left\./);
	assert.doesNotMatch(output, /\[bob\] assistant: Still running/);
});
