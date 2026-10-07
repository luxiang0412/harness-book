/**
 * 第 11 章示例：危险命令确认。
 * 改编自 pi 的 packages/coding-agent/examples/extensions/permission-gate.ts。
 *
 *   node src/main.ts -e examples/extensions/permission-gate.ts
 */

import type { ExtensionAPI } from "../../src/extensions/types.ts";

const DANGEROUS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i, /\bgit\s+push\s+.*--force/i];

export default function (mini: ExtensionAPI) {
	mini.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command);
		if (!DANGEROUS.some((pattern) => pattern.test(command))) return undefined;

		// 没有 UI (print/json/rpc 模式) 时默认拒绝：无人确认 ≠ 同意。
		if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		const allowed = await ctx.ui.confirm("Dangerous command", command);
		return allowed ? undefined : { block: true, reason: "Blocked by user" };
	});
}
