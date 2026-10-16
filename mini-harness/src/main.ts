#!/usr/bin/env node
/**
 * mini-harness 命令行入口。
 *
 *   node src/main.ts                       交互模式
 *   node src/main.ts -p "问题"              print 模式
 *   node src/main.ts --mode json "问题"     JSON 事件流
 *   node src/main.ts --mode rpc            RPC 模式
 *   node src/main.ts --demo                用 faux 模型离线体验
 *
 * 启动顺序 (和 pi 的 main.ts 一致)：
 *   解析参数 → 项目信任 → 设置 → 资源 → 扩展 → 模型 → 会话 → 运行模式
 */

import { join } from "node:path";
import { createFauxModel, type FauxStep } from "./ai/faux.ts";
import { defaultModel, findModel, getApiKey } from "./ai/models.ts";
import type { Context, Model } from "./ai/types.ts";
import { contentText } from "./ai/types.ts";
import { createCodeModeTool } from "./codemode/codemode.ts";
import { getAgentDir, loadSettings } from "./config.ts";
import { createPendingActions, loadExtensions } from "./extensions/loader.ts";
import type { ExtensionUI } from "./extensions/types.ts";
import { loadMcpTools } from "./mcp/bridge.ts";
import { InteractiveMode } from "./modes/interactive.ts";
import { runPrintMode } from "./modes/print.ts";
import { runRpcMode } from "./modes/rpc.ts";
import { loadResources } from "./resources.ts";
import { AgentSession } from "./session/agent-session.ts";
import { defaultSessionDir, SessionManager } from "./session/session-manager.ts";
import { createCodingTools } from "./tools/index.ts";
import { resolveProjectTrust } from "./trust.ts";

interface Args {
	mode: "interactive" | "text" | "json" | "rpc";
	prompt?: string;
	model?: string;
	continueSession: boolean;
	resume?: string;
	noSession: boolean;
	extensions: string[];
	approve?: boolean;
	noTools: boolean;
	codemode: boolean;
	demo: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { mode: "interactive", continueSession: false, noSession: false, extensions: [], noTools: false, codemode: false, demo: false };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") args.mode = "text";
		else if (arg === "--mode") args.mode = argv[++i] as Args["mode"];
		else if (arg === "-m" || arg === "--model") args.model = argv[++i];
		else if (arg === "-c" || arg === "--continue") args.continueSession = true;
		else if (arg === "--resume") args.resume = argv[++i];
		else if (arg === "--no-session") args.noSession = true;
		else if (arg === "-e" || arg === "--extension") args.extensions.push(argv[++i]);
		else if (arg === "--approve") args.approve = true;
		else if (arg === "--no-approve") args.approve = false;
		else if (arg === "--no-tools") args.noTools = true;
		else if (arg === "--codemode") args.codemode = true;
		else if (arg === "--demo") args.demo = true;
		else if (arg === "-h" || arg === "--help") {
			console.log(
				"Usage: mini [-p|--mode json|rpc] [-m provider/id] [-c] [--resume file] [--no-session] [-e ext.ts] [--approve|--no-approve] [--codemode] [--demo] [prompt]",
			);
			process.exit(0);
		} else rest.push(arg);
	}
	if (rest.length > 0) args.prompt = rest.join(" ");
	return args;
}

/** --demo：不需要 API key 的假模型。看到"read"就去读 README，否则复述输入。 */
function demoModel(): Model {
	const step: FauxStep = (context: Context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return `I read it. It starts with: ${contentText(last.content).split("\n")[0]}`;
		const text = last?.role === "user" ? contentText(last.content) : "";
		if (/read/i.test(text)) return [{ type: "toolCall", id: `demo_${Date.now()}`, name: "read", arguments: { path: "README.md", limit: 5 } }];
		return `(demo model) You said: ${text}`;
	};
	return createFauxModel(Array.from({ length: 10_000 }, () => step), { id: "demo" }).model;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const interactive = args.mode === "interactive";

	// 1. 项目信任：决定是否加载 .mini/ 下的项目资源
	const preliminary = loadSettings(agentDir, cwd, false);
	const projectTrusted = await resolveProjectTrust({
		agentDir,
		cwd,
		override: args.approve,
		defaultTrust: preliminary.defaultProjectTrust,
		ask: interactive ? askTrust : undefined,
	});
	const settings = loadSettings(agentDir, cwd, projectTrusted);

	// 2. 资源与扩展
	const resources = loadResources({ agentDir, cwd, projectTrusted, extraExtensions: args.extensions });
	const actions = createPendingActions();
	const loaded = await loadExtensions(resources.extensionPaths, actions);
	for (const error of loaded.errors) console.error(`Failed to load extension ${error.path}: ${error.error}`);

	// 3. 模型
	const model = args.demo ? demoModel() : findModel(args.model ?? settings.defaultModel ?? "") ?? defaultModel();
	if (!model) {
		console.error("No model available. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY, or MINI_BASE_URL + MINI_MODEL, or use --demo.");
		process.exit(1);
	}

	// 4. 会话
	const sessionDir = defaultSessionDir(cwd, agentDir);
	let sessionManager: SessionManager;
	if (args.resume) sessionManager = SessionManager.open(args.resume);
	else if (args.continueSession && SessionManager.list(sessionDir)[0]) sessionManager = SessionManager.open(SessionManager.list(sessionDir)[0].file);
	else if (args.noSession) sessionManager = SessionManager.inMemory(cwd);
	else sessionManager = SessionManager.create(cwd, sessionDir);

	// 5. 工具：内置 + MCP (第 12 章) + code mode (第 17 章)
	const tools = args.noTools ? [] : createCodingTools(cwd);
	const mcp = await loadMcpTools([join(agentDir, "mcp.json"), ...(projectTrusted ? [join(cwd, ".mini", "mcp.json")] : [])]);
	for (const error of mcp.errors) console.error(`MCP: ${error}`);
	tools.push(...mcp.tools);

	let interactiveMode: InteractiveMode | undefined;
	let ui: ExtensionUI | undefined;
	const session = new AgentSession({
		cwd,
		model,
		sessionManager,
		tools,
		resources,
		extensions: loaded.extensions,
		extensionActions: actions,
		getApiKey: (provider) => getApiKey(provider),
		compaction: settings.compaction,
		retry: settings.retry,
		hasUI: interactive,
		// 交互模式的 UI 要等 session 创建后才能构造，这里先放一个转发层。
		ui: {
			notify: (message, level) => (ui ? ui.notify(message, level) : console.error(`[${level ?? "info"}] ${message}`)),
			confirm: async (title, message) => (ui ? ui.confirm(title, message) : false),
			select: async (title, options) => ui?.select(title, options),
			input: async (prompt) => ui?.input(prompt),
		},
	});
	if (args.codemode) {
		// code mode 工具需要拿到 session 的其他工具和钩子，所以在 session 创建后再加入。
		session.addTool(
			createCodeModeTool({
				getTools: () => session.getAllTools().filter((tool) => session.getActiveToolNames().includes(tool.name)),
				beforeToolCall: session.agent.beforeToolCall,
				afterToolCall: session.agent.afterToolCall,
			}),
		);
	}
	if (interactive) {
		interactiveMode = new InteractiveMode(session);
		ui = interactiveMode.createExtensionUI();
	}

	await session.start();
	let exitCode = 0;
	try {
		if (args.mode === "text" || args.mode === "json") {
			if (!args.prompt) throw new Error("print/json mode needs a prompt");
			exitCode = await runPrintMode(session, args.prompt, args.mode);
		} else if (args.mode === "rpc") {
			await runRpcMode(session);
		} else {
			if (args.prompt) void session.prompt(args.prompt);
			await interactiveMode?.run();
		}
	} finally {
		await session.dispose();
		await mcp.close();
	}
	process.exit(exitCode);
}

async function askTrust(cwd: string): Promise<boolean> {
	process.stdout.write(`This folder has project resources (.mini/) that can run code:\n  ${cwd}\nTrust it? [y/N] `);
	const answer = await new Promise<string>((resolve) => process.stdin.once("data", (data) => resolve(data.toString())));
	return /^y/i.test(answer.trim());
}

// 输出被管道下游提前关闭 (例如 `| head`) 时安静退出。
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
