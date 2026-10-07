/**
 * 第 2 章示例：不到 100 行的完整 agent。
 *
 * 只依赖第 1 章的 stream()。没有事件、没有钩子、没有中断，
 * 但它已经是一个真正的 agent：能读文件、跑命令，直到任务完成。
 *
 *   node examples/ch02-minimal-loop.ts                     # faux 模型，离线运行
 *   ANTHROPIC_API_KEY=... node examples/ch02-minimal-loop.ts anthropic/claude-sonnet-5-5 "这个目录里有什么？"
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createFauxModel, toolCall } from "../src/ai/faux.ts";
import { findModel, getApiKey } from "../src/ai/models.ts";
import { stream } from "../src/ai/stream.ts";
import type { Message, Tool, ToolResultMessage } from "../src/ai/types.ts";

// ---- 1. 工具：声明 + 实现 ----
const tools: Tool[] = [
	{
		name: "read",
		description: "Read a text file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "bash",
		description: "Run a bash command and return its output",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
];

function runTool(name: string, args: Record<string, unknown>): string {
	if (name === "read") return readFileSync(String(args.path), "utf-8");
	if (name === "bash") return execSync(String(args.command), { encoding: "utf-8" });
	throw new Error(`Unknown tool ${name}`);
}

// ---- 2. 模型 ----
const [spec, ...words] = process.argv.slice(2);
const model = spec
	? findModel(spec)
	: createFauxModel([[toolCall("bash", { command: "ls" })], "I listed the directory for you."]).model;
if (!model) throw new Error(`Unknown model ${spec}`);
const task = words.join(" ") || "What files are in this directory?";

// ---- 3. 循环 ----
const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];

while (true) {
	const response = stream(model, { systemPrompt: "You are a helpful coding assistant.", messages, tools }, { apiKey: getApiKey(model.provider) });
	for await (const event of response) {
		if (event.type === "text_delta") process.stdout.write(event.delta);
	}
	const assistant = await response.result();
	messages.push(assistant);

	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		console.error(`\nError: ${assistant.errorMessage}`);
		break;
	}

	const calls = assistant.content.filter((block) => block.type === "toolCall");
	if (calls.length === 0) break; // 没有工具调用 = 模型认为任务完成

	for (const call of calls) {
		console.log(`\n$ ${call.name} ${JSON.stringify(call.arguments)}`);
		let text: string;
		let isError = false;
		try {
			text = runTool(call.name, call.arguments);
		} catch (error) {
			// 工具失败不能让循环崩溃：把错误告诉模型，让它自己调整。
			text = error instanceof Error ? error.message : String(error);
			isError = true;
		}
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: text.slice(0, 20_000) }],
			isError,
			timestamp: Date.now(),
		};
		messages.push(result);
	}
}
console.log();
