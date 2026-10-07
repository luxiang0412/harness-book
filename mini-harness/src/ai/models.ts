/**
 * 第 1 章 / 第 14 章：模型目录与凭据解析。
 *
 * pi 的模型目录是从 pi.dev 生成的 (packages/ai/scripts/generate-models.ts)，
 * 每个模型带有 api、baseUrl、上下文窗口、价格等元数据。
 * 这里只放几个示例。上下文窗口和输出上限是示例值，以各家官方文档为准。
 */

import type { Model } from "./types.ts";

export const BUILTIN_MODELS: Model[] = [
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 16_000,
		reasoning: true,
	},
	{
		id: "gpt-4.1",
		name: "GPT-4.1",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 1_000_000,
		maxTokens: 32_000,
		reasoning: false,
	},
	{
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		contextWindow: 128_000,
		maxTokens: 8_000,
		reasoning: false,
	},
];

/** 每个 provider 默认从哪个环境变量读取 API key。 */
const API_KEY_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	custom: "MINI_API_KEY",
};

export function getApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = API_KEY_ENV[provider];
	return name ? env[name] : undefined;
}

/**
 * 按 "provider/id" 或 "id" 查找模型。
 * 环境变量 MINI_BASE_URL + MINI_MODEL 可以声明任意 OpenAI 兼容端点 (Ollama、vLLM 等)，
 * 对应 pi 里 models.json 的自定义 provider。
 */
export function findModel(spec: string, env: NodeJS.ProcessEnv = process.env): Model | undefined {
	const custom = customModel(env);
	const all = custom ? [custom, ...BUILTIN_MODELS] : BUILTIN_MODELS;
	const slash = spec.indexOf("/");
	if (slash !== -1) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		return all.find((model) => model.provider === provider && model.id === id);
	}
	return all.find((model) => model.id === spec);
}

function customModel(env: NodeJS.ProcessEnv): Model | undefined {
	if (!env.MINI_BASE_URL || !env.MINI_MODEL) return undefined;
	return {
		id: env.MINI_MODEL,
		name: env.MINI_MODEL,
		api: "openai-completions",
		provider: "custom",
		baseUrl: env.MINI_BASE_URL.replace(/\/$/, ""),
		contextWindow: Number(env.MINI_CONTEXT_WINDOW ?? 32_000),
		maxTokens: Number(env.MINI_MAX_TOKENS ?? 4_096),
		reasoning: false,
	};
}

/** 选择默认模型：自定义端点 > 有 key 的内置 provider。 */
export function defaultModel(env: NodeJS.ProcessEnv = process.env): Model | undefined {
	const custom = customModel(env);
	if (custom) return custom;
	return BUILTIN_MODELS.find((model) => getApiKey(model.provider, env));
}
