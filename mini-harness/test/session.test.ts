/**
 * 第 5–7、10 章的行为测试：system prompt、会话树、压缩、扩展。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentTool } from "../src/agent/types.ts";
import { createFauxModel, toolCall } from "../src/ai/faux.ts";
import { estimateContextTokens } from "../src/compaction/compaction.ts";
import { loadContextFiles } from "../src/context/context-files.ts";
import { expandTemplate } from "../src/context/prompt-templates.ts";
import { loadSkills } from "../src/context/skills.ts";
import { buildSystemPromptSections, diffSections } from "../src/context/system-prompt.ts";
import { createPendingActions, loadExtensionFromFactory } from "../src/extensions/loader.ts";
import type { ExtensionFactory } from "../src/extensions/types.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { SessionManager } from "../src/session/session-manager.ts";
import { createCodingTools } from "../src/tools/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mini-"));

test("system prompt: rules follow the active tools", () => {
	const tools = createCodingTools("/repo");
	const all = buildSystemPromptSections({ cwd: "/repo", tools });
	assert.match(all.rules, /Use edit for precise changes/);
	const withoutEdit = buildSystemPromptSections({ cwd: "/repo", tools: tools.filter((tool) => tool.name !== "edit") });
	assert.doesNotMatch(withoutEdit.rules, /Use edit/);
	const patch = diffSections(all, withoutEdit);
	assert.deepEqual(Object.keys(patch ?? {}).sort(), ["rules", "tools"]);
});

test("context files: outer first, inner last", () => {
	const root = tmp();
	mkdirSync(join(root, "pkg", "web"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "root rules");
	writeFileSync(join(root, "pkg", "AGENTS.md"), "pkg rules");
	const files = loadContextFiles(join(root, "pkg", "web"), join(root, "no-global"));
	const contents = files.map((file) => file.content);
	assert.equal(contents.at(-2), "root rules");
	assert.equal(contents.at(-1), "pkg rules");
});

test("skills and templates", () => {
	const dir = tmp();
	mkdirSync(join(dir, "skills", "pdf"), { recursive: true });
	writeFileSync(join(dir, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Work with PDFs\n---\nUse pdftotext.");
	const skills = loadSkills([join(dir, "skills")]);
	assert.equal(skills[0].name, "pdf");
	const prompt = buildSystemPromptSections({ cwd: dir, tools: createCodingTools(dir), skills });
	assert.match(prompt.skills, /<name>pdf<\/name>/);

	const templates = [{ name: "review", description: "", body: "Review focusing on ${1:-correctness}." }];
	assert.equal(expandTemplate("/review security", templates), "Review focusing on security.");
	assert.equal(expandTemplate("/review", templates), "Review focusing on correctness.");
});

test("session tree: branch and rebuild context", () => {
	const session = SessionManager.inMemory();
	const u1 = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
	session.appendMessage({ role: "user", content: "second", timestamp: 2 });
	session.branch(u1);
	session.appendMessage({ role: "user", content: "alternative", timestamp: 3 });

	const texts = session.buildContext().messages.map((message) => (message.role === "user" ? message.content : ""));
	assert.deepEqual(texts, ["first", "alternative"]);
	assert.equal(session.getTree()[0].children.length, 2);
});

test("in-memory sessions write no file (--no-session)", async () => {
	const dir = tmp();
	const session = SessionManager.inMemory(dir);
	const agentSession = new AgentSession({ cwd: dir, model: createFauxModel(["hi"]).model, sessionManager: session, tools: [] });
	await agentSession.prompt("hello");
	assert.equal(session.file, undefined);
	assert.equal(session.buildContext().messages.length, 2);
});

test("session file round trip", async () => {
	const dir = tmp();
	const faux = createFauxModel(["hello back"]);
	const session = SessionManager.create(dir, dir);
	const agentSession = new AgentSession({ cwd: dir, model: faux.model, sessionManager: session, tools: [] });
	await agentSession.prompt("hello");
	assert.ok(session.file);
	const reopened = SessionManager.open(session.file!);
	const roles = reopened.buildContext().messages.map((message) => message.role);
	assert.deepEqual(roles, ["user", "assistant"]);
});

test("compaction replaces old history with a summary", async () => {
	const dir = tmp();
	const bigText = "x".repeat(4000); // 约 1000 token
	const faux = createFauxModel(
		[
			bigText,
			bigText,
			bigText,
			// 第 4 次请求之前触发压缩：这一步是摘要请求
			(context) => {
				assert.match(context.systemPrompt ?? "", /summarization assistant/);
				return "## Goal\nTest compaction";
			},
			"after compaction",
		],
		{ contextWindow: 4000 },
	);
	const session = SessionManager.inMemory(dir);
	const agentSession = new AgentSession({
		cwd: dir,
		model: faux.model,
		sessionManager: session,
		tools: [],
		compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1200 },
	});
	const events: string[] = [];
	agentSession.subscribe((event) => {
		if (event.type.startsWith("compaction")) events.push(event.type);
	});
	await agentSession.prompt("one");
	await agentSession.prompt("two");
	await agentSession.prompt("three");
	await agentSession.prompt("four");
	assert.deepEqual(events, ["compaction_start", "compaction_end"]);
	const first = agentSession.messages[0];
	assert.equal(first.role, "summary");
	assert.ok(estimateContextTokens(agentSession.messages) < 4000);
	// 原始历史仍然在会话文件里
	assert.ok(session.getEntries().filter((entry) => entry.type === "message").length >= 8);
});

test("extension: tool_call can block, tool_result can rewrite, command runs", async () => {
	const dir = tmp();
	const commands: string[] = [];
	const factory: ExtensionFactory = (mini) => {
		mini.on("tool_call", async (event) => {
			if (event.toolName === "bash" && String(event.input.command).includes("rm -rf")) {
				return { block: true, reason: "Dangerous command blocked" };
			}
			return undefined;
		});
		mini.on("tool_result", async (event) => {
			if (event.toolName === "echo") return { content: [{ type: "text", text: "[redacted]" }] };
			return undefined;
		});
		mini.registerCommand("hello", { description: "say hi", handler: (args) => void commands.push(args) });
		const echo: AgentTool<{ text: string }> = {
			name: "echo",
			description: "echo",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			execute: async (_id, { text }) => ({ content: [{ type: "text", text }] }),
		};
		mini.registerTool(echo);
	};
	const actions = createPendingActions();
	const extension = await loadExtensionFromFactory(factory, "<inline>", actions);
	const faux = createFauxModel([[toolCall("bash", { command: "rm -rf /" }), toolCall("echo", { text: "secret" })], "ok"]);
	const agentSession = new AgentSession({
		cwd: dir,
		model: faux.model,
		sessionManager: SessionManager.inMemory(dir),
		tools: createCodingTools(dir),
		extensions: [extension],
		extensionActions: actions,
	});
	await agentSession.prompt("/hello world");
	assert.deepEqual(commands, ["world"]);
	await agentSession.prompt("go");
	const results = agentSession.messages.filter((message) => message.role === "toolResult");
	assert.match(JSON.stringify(results[0]), /Dangerous command blocked/);
	assert.match(JSON.stringify(results[1]), /\[redacted\]/);
});

test("extension that throws in tool_call blocks the tool (fail closed)", async () => {
	const dir = tmp();
	const actions = createPendingActions();
	const extension = await loadExtensionFromFactory(
		(mini) => {
			mini.on("tool_call", async () => {
				throw new Error("policy service unavailable");
			});
		},
		"<inline>",
		actions,
	);
	const faux = createFauxModel([[toolCall("bash", { command: "echo hi" })], "ok"]);
	const agentSession = new AgentSession({
		cwd: dir,
		model: faux.model,
		sessionManager: SessionManager.inMemory(dir),
		tools: createCodingTools(dir),
		extensions: [extension],
		extensionActions: actions,
	});
	await agentSession.prompt("go");
	const result = agentSession.messages.find((message) => message.role === "toolResult");
	assert.match(JSON.stringify(result), /blocked: policy service unavailable/);
});

test("retryable error is retried with backoff", async () => {
	const dir = tmp();
	let calls = 0;
	const faux = createFauxModel([
		() => {
			calls += 1;
			throw new Error("429 rate limit");
		},
		() => {
			calls += 1;
			return "recovered";
		},
	]);
	const agentSession = new AgentSession({
		cwd: dir,
		model: faux.model,
		sessionManager: SessionManager.inMemory(dir),
		tools: [],
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
	});
	await agentSession.prompt("hi");
	assert.equal(calls, 2);
	assert.equal(agentSession.lastAssistant()?.stopReason, "stop");
});
