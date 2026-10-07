/**
 * 第 1 章示例：直接调用统一的 stream()，打印流式事件。
 *
 *   node examples/ch01-stream.ts                       # 用 faux 模型
 *   ANTHROPIC_API_KEY=... node examples/ch01-stream.ts anthropic/claude-sonnet-5-5
 */

import { createFauxModel } from "../src/ai/faux.ts";
import { findModel, getApiKey } from "../src/ai/models.ts";
import { stream } from "../src/ai/stream.ts";

const spec = process.argv[2];
const model = spec ? findModel(spec) : createFauxModel(["Hello! I am a scripted model."]).model;
if (!model) throw new Error(`Unknown model ${spec}`);

const events = stream(
	model,
	{
		systemPrompt: "You are concise.",
		messages: [{ role: "user", content: "Say hello in one sentence.", timestamp: Date.now() }],
	},
	{ apiKey: getApiKey(model.provider) },
);

for await (const event of events) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
	else if (!event.type.endsWith("_delta")) console.log(`\n[${event.type}]`);
}

const message = await events.result();
console.log("\nstopReason:", message.stopReason, "usage:", message.usage);
