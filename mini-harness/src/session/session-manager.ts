/**
 * 第 6 章：会话持久化 —— 追加写入的 JSONL 会话树。
 *
 * 对应 pi 的 packages/coding-agent/src/core/session-manager.ts。
 *
 * 文件格式：第一行是 header，之后每行一个 entry。
 * 每个 entry 有 id 和 parentId，所有 entry 构成一棵树。
 * leaf 指向"当前位置"，从 leaf 沿 parentId 走到根，就是当前分支的历史。
 *
 *   {"type":"session","version":1,"id":"…","cwd":"/repo"}
 *   {"type":"message","id":"a1","parentId":null,"message":{"role":"user",…}}
 *   {"type":"message","id":"b2","parentId":"a1","message":{"role":"assistant",…}}
 *   {"type":"message","id":"c3","parentId":"a1","message":{"role":"user",…}}   ← 从 a1 分叉
 *
 * 只追加、从不修改：
 * - 崩溃时最多丢最后一行，不会把整个文件写坏；
 * - 分支不需要复制文件，只是在旧节点下面挂新的子节点；
 * - 压缩也只是追加一条 compaction entry，原始历史仍然保留。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../agent/types.ts";

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	timestamp: string;
	cwd: string;
}

interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
}

/** 第 7 章：firstKeptEntryId 之前的历史被 summary 替代。 */
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

/** 离开一个分支时，对它的摘要。 */
export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/** 扩展的私有状态 (第 10 章)。不进入模型上下文。 */
export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data: unknown;
}

export type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry | ModelChangeEntry | CustomEntry;

export interface SessionContext {
	messages: AgentMessage[];
	model?: { provider: string; modelId: string };
}

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
}

export function defaultSessionDir(cwd: string, root = join(homedir(), ".mini")): string {
	const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(root, "sessions", safe);
}

export class SessionManager {
	readonly header: SessionHeader;
	/** undefined 表示只在内存中 (测试、--no-session)。 */
	readonly file: string | undefined;
	private readonly entries: SessionEntry[] = [];
	private readonly byId = new Map<string, SessionEntry>();
	private leafId: string | null = null;
	/** 文件是否已经落盘。只有出现了真正的对话才创建文件，避免空会话垃圾文件。 */
	private flushed = false;

	private constructor(header: SessionHeader, file: string | undefined) {
		this.header = header;
		this.file = file;
	}

	/**
	 * sessionDir 为 undefined 时只在内存里。注意这里不能写成默认参数
	 * (`sessionDir = defaultSessionDir(cwd)`)：显式传入的 undefined 也会触发默认值，
	 * 内存会话就会悄悄写进 ~/.mini。
	 */
	static create(cwd: string, sessionDir: string | undefined): SessionManager {
		const id = randomUUID();
		const timestamp = new Date().toISOString();
		let file: string | undefined;
		if (sessionDir) {
			mkdirSync(sessionDir, { recursive: true });
			file = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		}
		return new SessionManager({ type: "session", version: 1, id, timestamp, cwd }, file);
	}

	static inMemory(cwd = process.cwd()): SessionManager {
		return SessionManager.create(cwd, undefined);
	}

	static open(file: string): SessionManager {
		const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim());
		let header: SessionHeader | undefined;
		const entries: SessionEntry[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as SessionHeader | SessionEntry;
				if (parsed.type === "session") header = parsed;
				else entries.push(parsed);
			} catch {
				// 损坏的行 (例如崩溃时写了一半) 直接跳过。
			}
		}
		if (!header) throw new Error(`Not a session file: ${file}`);
		const manager = new SessionManager(header, file);
		for (const entry of entries) {
			manager.entries.push(entry);
			manager.byId.set(entry.id, entry);
			manager.leafId = entry.id; // 默认停在最后写入的 entry
		}
		manager.flushed = true;
		return manager;
	}

	/** 最近修改的会话排在前面。 */
	static list(sessionDir: string): { file: string; mtime: Date; firstMessage: string }[] {
		if (!existsSync(sessionDir)) return [];
		return readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const file = join(sessionDir, name);
				const firstUser = readFileSync(file, "utf-8")
					.split("\n")
					.map((line) => {
						try {
							return JSON.parse(line) as SessionEntry;
						} catch {
							return undefined;
						}
					})
					.find((entry) => entry?.type === "message" && entry.message.role === "user") as MessageEntry | undefined;
				const content = firstUser?.message.role === "user" ? firstUser.message.content : "";
				const firstMessage = typeof content === "string" ? content : (content.find((block) => block.type === "text")?.text ?? "");
				return { file, mtime: statSync(file).mtime, firstMessage: firstMessage.slice(0, 80) };
			})
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	}

	get sessionId(): string {
		return this.header.id;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getEntries(): SessionEntry[] {
		return this.entries.slice();
	}

	// ---------- 写入 ----------

	private newId(): string {
		let id: string;
		do id = randomBytes(4).toString("hex");
		while (this.byId.has(id));
		return id;
	}

	private append<T extends SessionEntry>(entry: Omit<T, "id" | "parentId" | "timestamp">): T {
		const full = { ...entry, id: this.newId(), parentId: this.leafId, timestamp: new Date().toISOString() } as T;
		this.entries.push(full);
		this.byId.set(full.id, full);
		this.leafId = full.id;
		this.persist(full);
		return full;
	}

	private persist(entry: SessionEntry): void {
		if (!this.file) return;
		if (this.flushed) {
			appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
			return;
		}
		const hasConversation = this.entries.some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
		if (!hasConversation) return;
		// 第一次落盘：header 加上此前缓存在内存里的全部 entry。
		const lines = [this.header, ...this.entries].map((e) => JSON.stringify(e));
		writeFileSync(this.file, `${lines.join("\n")}\n`, { flag: "wx" });
		this.flushed = true;
	}

	appendMessage(message: AgentMessage): string {
		return this.append<MessageEntry>({ type: "message", message }).id;
	}

	appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
		return this.append<CompactionEntry>({ type: "compaction", summary, firstKeptEntryId, tokensBefore }).id;
	}

	appendModelChange(provider: string, modelId: string): string {
		return this.append<ModelChangeEntry>({ type: "model_change", provider, modelId }).id;
	}

	appendCustom(customType: string, data: unknown): string {
		return this.append<CustomEntry>({ type: "custom", customType, data }).id;
	}

	// ---------- 分支 ----------

	/** 把 leaf 移到某个旧 entry。下一次 append 会从那里长出新分支。 */
	branch(entryId: string): void {
		if (!this.byId.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		this.leafId = entryId;
	}

	/** 分支并附上被离开分支的摘要，让模型知道"刚才在另一条路上做过什么"。 */
	branchWithSummary(entryId: string, summary: string): string {
		const fromId = this.leafId ?? entryId;
		this.branch(entryId);
		return this.append<BranchSummaryEntry>({ type: "branch_summary", fromId, summary }).id;
	}

	// ---------- 读取 ----------

	/** 从根到 leaf 的路径。 */
	getPath(leafId: string | null = this.leafId): SessionEntry[] {
		const path: SessionEntry[] = [];
		let current = leafId ? this.byId.get(leafId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	/**
	 * 从当前分支重建模型上下文。遇到压缩时：
	 *
	 *   path:  u1 a1 t1 u2 a2 t2 [compaction firstKept=u2] u3 a3
	 *   结果:  [summary] u2 a2 t2 u3 a3
	 */
	buildContext(leafId: string | null = this.leafId): SessionContext {
		const path = this.getPath(leafId);
		let model: SessionContext["model"];
		for (const entry of path) {
			if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
			if (entry.type === "message" && entry.message.role === "assistant") {
				model = { provider: entry.message.provider, modelId: entry.message.model };
			}
		}

		let compactionIndex = -1;
		for (let i = path.length - 1; i >= 0; i--) {
			if (path[i].type === "compaction") {
				compactionIndex = i;
				break;
			}
		}

		const messages: AgentMessage[] = [];
		const include = (entry: SessionEntry) => {
			if (entry.type === "message") messages.push(entry.message);
			else if (entry.type === "branch_summary") {
				messages.push({ role: "summary", kind: "branch", summary: entry.summary, timestamp: Date.parse(entry.timestamp) });
			}
		};

		if (compactionIndex === -1) {
			for (const entry of path) include(entry);
			return { messages, model };
		}

		const compaction = path[compactionIndex] as CompactionEntry;
		messages.push({ role: "summary", kind: "compaction", summary: compaction.summary, timestamp: Date.parse(compaction.timestamp) });
		let keeping = false;
		for (let i = 0; i < compactionIndex; i++) {
			if (path[i].id === compaction.firstKeptEntryId) keeping = true;
			if (keeping) include(path[i]);
		}
		for (let i = compactionIndex + 1; i < path.length; i++) include(path[i]);
		return { messages, model };
	}

	getTree(): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		for (const entry of this.entries) nodes.set(entry.id, { entry, children: [] });
		const roots: SessionTreeNode[] = [];
		for (const entry of this.entries) {
			const node = nodes.get(entry.id)!;
			const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}
}
