# 第 11 章　扩展实战与分发

> 本章对应 pi 的 `packages/coding-agent/examples/extensions/`、`core/package-manager.ts` 和 `docs/packages.md`，mini-harness 的 `examples/extensions/`。

上一章讲了扩展系统的原理。这一章读几个真实的扩展，看看常见需求如何用扩展 API 实现，最后讲扩展怎么打包分发。

## 11.1 权限确认：拦截危险命令

**需求**：执行 `rm -rf`、`sudo`、`chmod 777` 之前先问用户。

pi 的 `examples/extensions/permission-gate.ts` 只有 30 行：

```typescript
export default function (pi: ExtensionAPI) {
  const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    if (!dangerousPatterns.some((p) => p.test(command))) return undefined;

    if (!ctx.hasUI) {
      // In non-interactive mode, block by default
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
    }
    const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}
```

三个要点：

1. **没有 UI 时默认拒绝。** print / JSON 模式没人能回答，"无人确认"不等于"同意"。
2. **`reason` 是写给模型看的。** 模型收到 "Blocked by user" 的错误结果，会换一种方式或者询问用户，而不是一直重试。
3. **正则匹配不是安全边界。** `rm -r -f`、`find . -delete`、`python -c "import shutil; ..."` 都能绕过。这个扩展防的是**模型的失误**，不是恶意行为。真正的隔离要靠操作系统 (第 13 章)。

一个更精细的方向是利用工具的 `annotations`。MCP 工具会声明 `readOnlyHint`、`destructiveHint` 等提示，pi 的文档里给了一个按提示决定是否需要确认的例子 (第 10 章提到)。

mini-harness 的版本在 `examples/extensions/permission-gate.ts`：

```bash
node src/main.ts -e examples/extensions/permission-gate.ts
```

## 11.2 保护路径

**需求**：永远不许修改 `.env`、`.git/`、`node_modules/`。

pi 的 `protected-paths.ts` 同样监听 `tool_call`，检查 write 和 edit 的 `path` 参数。和权限确认的区别是：它不问，直接拒绝，并通过 `ctx.ui.notify` 提示用户。

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const path = event.input.path as string;
  if (protectedPaths.some((p) => path.includes(p))) {
    if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
    return { block: true, reason: `Path "${path}" is protected` };
  }
});
```

同样要注意：它只拦截 write 和 edit。模型用 `bash` 执行 `echo x > .env` 照样能写。如果要做严格的保护，要么同时检查 bash 命令，要么用文件系统权限。

## 11.3 plan mode

**需求**：先只读调研、给出计划，用户确认后再修改。

pi 的 `examples/extensions/plan-mode/` 是一个完整实现。mini-harness 的精简版 (`examples/extensions/plan-mode.ts`) 展示了核心结构：

```typescript
export default function (mini: ExtensionAPI) {
  let planning = false;
  let savedTools: string[] = [];

  // 1. 恢复状态：沿当前分支找最后一次切换记录
  mini.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getPath()) {
      if (entry.type === "custom" && entry.customType === "plan-mode") planning = entry.data.planning;
    }
    if (planning) { savedTools = mini.getAllTools(); mini.setActiveTools(READ_ONLY); }
  });

  // 2. 命令切换模式，状态写进会话
  mini.registerCommand("plan", {
    description: "Toggle read-only planning mode",
    handler: async (_args, ctx) => {
      planning = !planning;
      if (planning) { savedTools = mini.getActiveTools(); mini.setActiveTools(READ_ONLY); }
      else mini.setActiveTools(savedTools);
      mini.appendEntry("plan-mode", { planning });
    },
  });

  // 3. 告诉模型现在是规划阶段
  mini.on("before_agent_start", async (event) => {
    if (!planning) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n<plan_mode>\nYou are in planning mode. Do not modify files...\n</plan_mode>` };
  });

  // 4. 双保险：即使模型绕过提示，也拦下写操作
  mini.on("tool_call", async (event) => {
    if (planning && !READ_ONLY.includes(event.toolName)) {
      return { block: true, reason: `Plan mode: ${event.toolName} is not allowed. Propose a plan instead.` };
    }
  });
}
```

四种扩展能力配合使用：命令、会话状态、system prompt、工具拦截。

第 3 步和第 4 步看起来重复：既然工具已经切换成只读，为什么还要拦截？因为 `setActiveTools` 只是不再声明写工具，模型仍然可能"记得"历史里用过 edit，幻觉出一个 edit 调用。没有声明的工具，loop 会返回 "Tool not found"，但给出明确的拒绝原因能让模型更快理解当前的限制。

## 11.4 带状态的工具：todo

**需求**：给模型一个任务清单工具，长任务里跟踪进度。

难点在状态管理。pi 的 `examples/extensions/todo.ts` 开头的注释说明了设计：

> State is stored in tool result details (not external files), which allows proper branching - when you branch, the todo state is automatically correct for that point in history.

每次调用 todo 工具，返回结果的 `details` 里带上完整的任务列表。恢复会话或切换分支时，从当前分支上最后一个 todo 工具结果读出状态。因为工具结果本身就在会话树里，分支切换时状态自动正确，不需要任何额外的同步逻辑。

mini-harness 的 `examples/extensions/todo-tool.ts` 用 `appendEntry` 实现了同样的效果 (也是存在会话树里)。两种方式的区别在于：`details` 只能由工具产生，`appendEntry` 可以在任何时候写入。

这个例子还展示了工具如何影响 system prompt：

```typescript
promptSnippet: "Track multi-step work in a todo list",
promptGuidelines: ["For tasks with 3+ steps, add them to the todo list first and mark each done as you finish it."],
```

## 11.5 git 检查点

**需求**：每一轮开始前保存代码状态，回退对话时可以同时回退代码。

这是一个很有价值的组合：第 6 章的会话树只管对话，代码的修改不会随着 leaf 移动而撤销。pi 的 `git-checkpoint.ts`：

```typescript
pi.on("turn_start", async () => {
  // 在模型修改代码之前，创建一个 stash 快照 (不改变工作区)
  const { stdout } = await pi.exec("git", ["stash", "create"]);
  if (stdout.trim() && currentEntryId) checkpoints.set(currentEntryId, stdout.trim());
});

pi.on("session_before_fork", async (event, ctx) => {
  const ref = checkpoints.get(event.entryId);
  if (!ref || !ctx.hasUI) return;
  const choice = await ctx.ui.select("Restore code state?", ["Yes, restore code to that point", "No, keep current code"]);
  if (choice?.startsWith("Yes")) await pi.exec("git", ["stash", "apply", ref]);
});
```

`git stash create` 是一个很巧妙的选择：它创建一个 stash 对象并返回它的 hash，但**不修改工作区，也不加入 stash 列表**。相当于给当前状态拍一张快照，开销很小。

## 11.6 子 agent

**需求**：把一个独立的子任务交给另一个 agent，主 agent 的上下文里只出现结果。

pi 没有内置子 agent。`examples/extensions/subagent/` 的实现方式值得注意：**启动另一个 pi 进程**。

```typescript
const args = ["--mode", "json", "-p", "--no-session"];
if (model) args.push("--model", model);
// ...
const proc = spawn("pi", args, { ... });
// 读取子进程的 JSON 事件流，把进度实时显示在父 agent 的工具输出里
```

它把第 9 章的 JSON 模式当作子 agent 的协议。好处是：

- **上下文隔离**：子 agent 有自己的上下文窗口，读了 50 个文件也不会占用父 agent 的空间；
- **进程隔离**：子 agent 崩溃不影响父 agent，Ctrl+C 可以杀掉子进程；
- **零新概念**：子 agent 就是一个普通的 pi，可以用不同的模型、不同的工具、不同的 system prompt。

扩展还定义了几种子 agent 角色 (`agents/scout.md`、`planner.md`、`reviewer.md`、`worker.md`)，以及组合它们的工作流 (`prompts/implement.md`：scout → planner → worker)。

## 11.7 接入新的模型服务

**需求**：公司有一个内部模型网关，协议是自定义的。

扩展可以注册 provider。有两种形式 (`docs/custom-provider.md`)：

- 注册一个完整的 `Provider` 对象 (第 1 章 1.8 节的 `createProvider()`)，自己控制认证、模型列表、流式实现。新的集成推荐这种方式；
- 用配置对象注册，适合"协议兼容、只是地址和模型不同"的情况：

```typescript
pi.registerProvider("my-gateway", {
  baseUrl: "https://llm.internal.example.com/v1",
  apiKey: "$MY_GATEWAY_KEY",         // $NAME 表示从环境变量读取
  api: "openai-completions",         // 复用已有的协议实现
  models: [{ id: "internal-large", contextWindow: 128000, maxTokens: 8192, ... }],
});
```

如果协议是全新的，就要提供自己的流式实现，也就是自己写一个第 1 章那样的适配器。`examples/extensions/custom-provider-anthropic/` 是一个完整的例子，包括 OAuth 登录；`custom-provider-gitlab-duo/` 展示了如何把流式请求委托给内置的 API 实现。

provider 注册发生在扩展加载阶段，pi 会等异步的工厂函数执行完再选择模型，所以 `pi --model my-gateway/internal-large` 能直接使用。

## 11.8 OS 级沙箱

**需求**：bash 命令不能读 `~/.ssh`，只能访问 github.com。

`examples/extensions/sandbox/` 用操作系统的沙箱机制 (macOS 的 sandbox-exec、Linux 的 bubblewrap) 限制 bash 命令的文件和网络访问。它展示了扩展的另一种能力：**替换内置工具**。注册一个同名的 `bash` 工具，就覆盖了内置的那个。

这比 11.1 节的正则匹配强得多：限制由操作系统执行，模型无论用什么命令都绕不过去。

## 11.9 打包分发：pi packages

写好的扩展、skill、prompt 模板、主题，怎么分享给别人？pi 的答案是 **pi package**：一个普通的 npm 包或 git 仓库。

### 结构

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

按约定的目录名放资源，pi 自动发现。也可以在 `package.json` 里显式声明：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"]
  }
}
```

### 安装

```bash
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi install ./local-package
pi -e npm:@example/pi-tools          # 只在这次运行中试用，不写入设置
```

安装记录写在 `~/.pi/agent/settings.json` (个人) 或 `.pi/settings.json` (项目，加 `--local`)。

### 依赖的处理

扩展会 import pi 的包 (`@earendil-works/pi-ai` 等)。这些包**不应该**出现在扩展的 `dependencies` 里，而应该声明为 `peerDependencies`，版本写 `"*"`。

原因是第 10 章讲的模块共享：如果扩展自己带一份 pi-ai，它拿到的类和宿主的不是同一个，`instanceof` 失效，单例被初始化两次。pi 安装扩展时会关闭 peer 依赖的自动安装，并在检测到这种错误配置时发出警告。

### 版本固定

`npm:@example/pi-tools@1.0.0` 和 `git:...@v1` 都固定了版本。`pi update` 会重新安装，但不会改变配置里写的版本。扩展在 pi 进程里以用户的全部权限运行，自动升级到一个未经审查的新版本是有风险的。

### 和信任的关系

项目级的 package 声明在 `.pi/settings.json` 里，只有项目被信任后才会安装和加载 (第 13 章)。pi 的文档特别提醒：

> Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it.

## 11.10 写扩展的检查清单

结合 pi 文档 (`docs/extensions.md`) 的建议：

- 工厂函数里只做注册，不启动进程、监听器、定时器。长期资源在 `session_start` 里创建，在 `session_shutdown` 里释放，释放逻辑要幂等；
- 用 `ctx.hasUI` 判断能否交互，没有 UI 时选择安全的默认行为；
- 拦截的 `reason` 要写给模型看，说明为什么被拦截、应该怎么做；
- 跟着分支走的状态，存在工具结果的 `details` 或 `appendEntry` 里，在 `session_start` 时沿当前分支重建；
- 修改文件的工具，用 `withFileMutationQueue()` 包住完整的读-改-写过程；
- 输出可能很大的工具，要截断并告诉模型完整输出在哪；
- 嵌套调用模型时用 `ctx.modelRegistry.streamSimple()`，并把用量记入结果的 `usage`。

## 11.11 动手

```bash
cd harness-book/mini-harness

# 同时加载三个示例扩展
node src/main.ts --demo -e examples/extensions/plan-mode.ts \
                        -e examples/extensions/permission-gate.ts \
                        -e examples/extensions/todo-tool.ts
> /plan
Plan mode ON: read-only tools, propose a plan first.
> /tools
Active tools: read
```

接真实模型试试 permission-gate：

```bash
ANTHROPIC_API_KEY=... node src/main.ts -e examples/extensions/permission-gate.ts
> 删除 /tmp/test-dir 目录
```

模型调用 `rm -rf` 时，输入框上方会出现确认问题。

## 练习

1. 写一个扩展：每次 agent 结束 (`agent_end`) 且有文件被修改时，自动 `git add -A && git commit`，提交信息让模型生成。注意：生成提交信息要用一个独立的模型调用，不能用 `sendUserMessage`，为什么？
2. 改进 permission-gate：把用户批准过的命令模式记住，同一个会话里不再重复询问。状态应该存在哪里？
3. 实现一个最小的子 agent 扩展：注册 `delegate` 工具，用 `node src/main.ts --mode json -p --no-session` 启动子进程，把子进程最后的回答作为工具结果返回。
4. 给 mini-harness 实现 package 支持：`mini install ./path`，把路径写进 `~/.mini/settings.json` 的 `packages` 数组，启动时从这些路径加载 `extensions/` 和 `skills/`。
