/**
 * 第 12 章：把 MCP 服务器的工具变成 harness 的工具。
 *
 * 对应 pi 的 packages/coding-agent/src/core/mcp-servers.ts。
 *
 * 配置格式和 Claude Desktop、Cursor 等客户端相同：
 *
 *   { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
 *
 * 工具命名为 mcp__<server>__<tool>：避免不同服务器的同名工具冲突，
 * 也让权限扩展能按前缀识别 MCP 工具。
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "../agent/types.ts";
import type { ImageContent, TextContent } from "../ai/types.ts";
import { McpClient, type McpContent, type StdioServerConfig } from "./client.ts";

export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** 展开 ${VAR}，让密钥留在环境变量里，不写进配置文件。 */
function expandEnv(value: string): string {
	return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function convertContent(content: McpContent[]): (TextContent | ImageContent)[] {
	return content.map((block): TextContent | ImageContent => {
		if (block.type === "text") return { type: "text", text: block.text ?? "" };
		if (block.type === "image" && block.data && block.mimeType) return { type: "image", data: block.data, mimeType: block.mimeType };
		return { type: "text", text: JSON.stringify(block) };
	});
}

export function createMcpTools(server: string, client: McpClient, tools: Awaited<ReturnType<McpClient["listTools"]>>): AgentTool[] {
	return tools.map((tool) => ({
		name: mcpToolName(server, tool.name),
		label: `${server}:${tool.name}`,
		description: tool.description ?? `MCP tool ${tool.name} from ${server}`,
		parameters: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
		async execute(_id, args, signal) {
			const result = await client.callTool(tool.name, args as Record<string, unknown>, signal);
			return { content: convertContent(result.content ?? []), isError: result.isError === true };
		},
	}));
}

export async function loadMcpTools(configPaths: string[]): Promise<{ tools: AgentTool[]; errors: string[]; close: () => Promise<void> }> {
	const servers = new Map<string, StdioServerConfig & { enabled?: boolean; url?: string }>();
	for (const path of configPaths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, StdioServerConfig> };
			// 后面的文件 (项目级) 覆盖前面的同名服务器。
			for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) servers.set(name, config);
		} catch (error) {
			return { tools: [], errors: [`${path}: ${String(error)}`], close: async () => {} };
		}
	}

	const tools: AgentTool[] = [];
	const errors: string[] = [];
	const clients: McpClient[] = [];
	// 并行连接：一个慢服务器不应该拖住其他服务器。
	await Promise.all(
		[...servers].map(async ([name, config]) => {
			if (config.enabled === false) return;
			if (config.url) {
				errors.push(`${name}: HTTP transport is not implemented in mini-harness (see pi's packages/mcp/src/transports/streamable-http.ts)`);
				return;
			}
			try {
				const client = await McpClient.connectStdio({
					command: expandEnv(config.command),
					args: config.args?.map(expandEnv),
					env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandEnv(value)])),
					cwd: config.cwd,
				});
				clients.push(client);
				tools.push(...createMcpTools(name, client, await client.listTools()));
			} catch (error) {
				errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}),
	);
	return {
		tools,
		errors,
		close: async () => {
			for (const client of clients) client.close();
		},
	};
}
