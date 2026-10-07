import type { AgentTool } from "../agent/types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/** pi 的默认工具集也是这四个：read、bash、edit、write。 */
export function createCodingTools(cwd: string): AgentTool[] {
	return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}
