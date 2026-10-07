/**
 * 第 9 章示例：在自己的程序里嵌入 harness (相当于 pi 的 SDK 用法)。
 *
 * 不经过任何"运行模式"，直接创建 AgentSession、订阅事件、发送 prompt。
 * 这里把它做成一个批量任务：对每个文件问同一个问题，收集答案。
 *
 *   node examples/ch09-sdk.ts                # faux 模型
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxModel, toolCall } from "../src/ai/faux.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { SessionManager } from "../src/session/session-manager.ts";
import { createCodingTools } from "../src/tools/index.ts";

const dir = mkdtempSync(join(tmpdir(), "sdk-"));
writeFileSync(join(dir, "a.ts"), "export const a = 1; // TODO: rename\n");
writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");

// 每个文件：先 read，再回答。
const faux = createFauxModel([
	[toolCall("read", { path: "a.ts" })],
	(context) => (JSON.stringify(context.messages.at(-1)).includes("TODO") ? "yes" : "no"),
	[toolCall("read", { path: "b.ts" })],
	(context) => (JSON.stringify(context.messages.at(-1)).includes("TODO") ? "yes" : "no"),
]);

const answers: Record<string, string> = {};
for (const file of ["a.ts", "b.ts"]) {
	// 每个文件一个独立的内存会话，互不影响。
	const session = new AgentSession({ cwd: dir, model: faux.model, sessionManager: SessionManager.inMemory(dir), tools: createCodingTools(dir) });
	session.subscribe((event) => {
		if (event.type === "tool_execution_start") console.log(`[${file}] ${event.toolName} ${JSON.stringify(event.args)}`);
	});
	await session.prompt(`Does ${file} contain a TODO? Answer yes or no.`);
	const last = session.lastAssistant();
	answers[file] = last?.content.find((block) => block.type === "text")?.text ?? "";
	await session.dispose();
}
console.log(answers);
