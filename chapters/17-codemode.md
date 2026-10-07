# 第 17 章　Code Mode：让模型写脚本调用工具

> 本章对应 pi 的 `packages/codemode` 和 `packages/coding-agent/docs/codemode.md`、`src/extensions/codemode/`，mini-harness 的 `src/codemode/codemode.ts`。

## 17.1 问题：一次只能调一个工具

假设任务是"找出 src 下所有包含 TODO 的文件，统计每个文件有几个"。用普通的 tool call，模型要这样做：

```text
turn 1:  bash("ls src")                           → 50 个文件名
turn 2:  bash("grep -c TODO src/a.ts")            → 3
turn 3:  bash("grep -c TODO src/b.ts")            → 0
...
turn 51: bash("grep -c TODO src/zz.ts")           → 1
turn 52: "共有 12 个文件包含 TODO……"
```

(聪明的模型会直接写 `grep -c TODO src/*`，但换成"调用 50 次 MCP 工具"的场景，就没有这种捷径了。)

即使模型在一条回复里并行发出 50 个 tool call，问题依然存在：

- **每个结果都进入上下文**。50 个结果，其中 38 个是 "0"，都是噪音；
- **每个中间步骤都要模型参与**。"先列文件，再逐个检查，再汇总"，每一步都要等模型决定下一步；
- **工具声明占用上下文**。第 12 章讲过，接入几个 MCP 服务器，工具声明就可能有几万 token。

## 17.2 思路：让模型写代码

模型很擅长写代码。与其让它一步步调用工具，不如让它写一段脚本，脚本里调用工具：

```javascript
const files = (await tools.bash({ command: "ls src" })).output.split("\n").filter(Boolean);
const counts = await Promise.all(
  files.map(async (f) => [f, Number((await tools.bash({ command: `grep -c TODO src/${f} || true` })).output)])
);
const hits = counts.filter(([, n]) => n > 0);
text(hits.map(([f, n]) => `${f}: ${n}`).join("\n"));
return `${hits.length} files`;
```

(这段脚本按 pi 的写法：bash 在脚本里返回 `{ output, exit_code, ... }` 对象，见 17.5 节。)

一次 tool call，模型只看到最后的结果 (12 行 + "12 files")。中间的 51 次工具调用、38 个 "0"，都没有进入上下文。

这就是 **code mode**：一个特殊的工具 `codemode`，它的参数是一段 JavaScript，脚本可以调用其他所有工具。

| | 普通 tool call | code mode |
|---|---|---|
| 一次能做的事 | 一个工具 | 任意组合：循环、并行、条件、过滤 |
| 中间结果 | 全部进入上下文 | 只有 `text()` 和返回值进入 |
| 模型参与 | 每一步 | 只在开始 (写脚本) 和结束 (看结果) |
| 工具声明 | 每个工具都要声明 | 可以只声明 codemode 一个，其余在脚本里搜索 |

## 17.3 沙箱：最关键的部分

让模型写的代码直接在 harness 进程里运行，是非常危险的。脚本可以 `require("fs")`、`process.exit()`、读环境变量里的 API key、发网络请求，绕过所有的工具权限检查。

pi 的 `packages/codemode` 用 **QuickJS** 运行脚本。QuickJS 是一个小巧的 JavaScript 引擎，pi 用的是编译成 **WebAssembly** 的版本，运行在一个独立的 worker 线程里：

```text
harness 进程 (Node.js)
└── worker 线程
    └── WebAssembly 实例
        └── QuickJS 引擎
            └── 模型写的脚本
```

WebAssembly 的内存是隔离的，QuickJS 里没有 Node.js 的任何 API。脚本**唯一的能力**就是调用宿主注入的函数：

> Runs model-written JavaScript in a QuickJS VM (compiled to WebAssembly) where the only capability is calling injected tools.

脚本里没有 `require`、`fetch`、`process`、定时器、`WebAssembly`。`eval` 和 `Function` 可以用，但只能在同一个沙箱里产生更多代码。

### 为什么不用 node:vm

Node.js 自带的 `vm` 模块看起来也能创建隔离的上下文：

```javascript
vm.runInNewContext("process.exit()", {});   // ReferenceError: process is not defined
```

但 Node 的文档明确写着 vm **不是安全机制**。传进上下文的任何对象都能通过原型链访问到宿主的 `Function` 构造器，进而执行任意宿主代码：

```javascript
// 只要沙箱里有任何一个来自宿主的对象 (比如注入的 tools)：
tools.constructor.constructor("return process")().exit();
```

mini-harness 为了零依赖，用的就是 `node:vm`，并在代码注释里明确标注：**它不是安全边界，只用来演示数据流**。在真实的 harness 里，必须使用 QuickJS/WASM、独立进程或者其他真正的隔离方案。

### 资源限制

隔离之外还要限制资源：

- **时间**：脚本可能写出死循环。同步的死循环要能强制终止 (pi 在 worker 线程里运行，可以直接终止线程)；异步的等待要有总的超时；
- **内存**：`memoryLimitBytes` 限制 QuickJS 的堆大小，超出时脚本里抛出 out of memory；
- **输出**：脚本可能 `text()` 一个巨大的字符串。pi 默认最多 10000 token，超出部分保留首尾，完整内容写到临时文件；
- **死锁检测**：脚本在等一个永远不会完成的 Promise (没有挂起的工具调用，沙箱里又没有定时器和 I/O)，pi 会立即判定失败，而不是等到超时。

## 17.4 权限检查不能被绕过

脚本里调用的工具，是否经过第 10 章的 `tool_call` 检查？必须经过。否则模型只要把危险命令写在脚本里，就绕过了所有权限扩展。

pi 的实现里，codemode 通过 `ctx.executeTool()` 调用其他工具。嵌套调用和模型直接发出的调用走同一条路径：参数校验、`tool_call` 处理器、执行、`tool_result` 处理器。第 2 章的 `runToolCall()` 就是为此导出的：

```typescript
// packages/agent/src/agent-loop.ts
/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 */
export async function runToolCall(toolCall, options): Promise<AgentToolCallOutcome>
```

mini-harness 的 codemode 也是这样做的：

```typescript
bindings[toIdentifier(tool.name)] = async (args) => {
  const plainArgs = JSON.parse(JSON.stringify(args ?? {}));   // 跨上下文的值先做 JSON 往返
  const { result, isError } = await runToolCall(
    { type: "toolCall", id: `${toolCallId}:${callIndex++}`, name: tool.name, arguments: plainArgs },
    context,
    { beforeToolCall: host.beforeToolCall, afterToolCall: host.afterToolCall },   // 复用 agent 的钩子
    signal,
  );
  if (isError) throw new Error(contentText(result.content));
  return contentText(result.content);
};
```

测试 "codemode: beforeToolCall hooks apply inside scripts" 验证了这一点：钩子拒绝时，脚本里的调用会抛出错误。

pi 还会记录嵌套调用：每个 codemode 结果消息上有一个 `nestedCalls` 字段，记录脚本调用了哪些工具、参数、状态、耗时 (不记录结果)。用于审计，以及压缩时的文件追踪 (第 7 章)。

## 17.5 让模型知道能调用什么

模型写脚本之前，要知道有哪些工具、每个工具的参数和返回值。pi 把工具的 JSON Schema 渲染成 **TypeScript 声明**，放进 codemode 工具的描述里：

```typescript
declare const tools: {
  /** Read a file */
  read(args: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<string>;
  /** Execute a bash command */
  bash(args: { command: string; timeout?: number }): Promise<{
    output: string;
    truncated: boolean;
    exit_code: number;
    wall_time_seconds: number;
  }>;
};
```

模型对 TypeScript 声明非常熟悉，这比 JSON Schema 更容易理解。

这里用到了第 3 章提到的 `outputSchema`：有输出 schema 的工具，在脚本里返回结构化的值。比如 bash 在脚本里返回 `{ output, exit_code, ... }`，而且 `output` 的上限是 1 MiB，比模型直接看到的 50KB 大得多，因为脚本会自己过滤。

工具太多时 (比如接了几个 MCP 服务器)，全部列出来又会占满上下文。pi 只在描述里列出一部分 (预算 3000 token)，其余的让脚本自己找：

```javascript
const hits = await searchTools("create github issue");     // BM25 排序
const decl = await describeTool(hits[0].name);              // 拿到完整的 TypeScript 声明
```

这就是第 12 章 MCP 工具默认 exposure 是 `codemode` 的原因：工具不声明给模型，脚本按需搜索。接入多少个 MCP 服务器，固定的上下文开销都很小。

## 17.6 状态：store 和 load

一个 codemode 脚本跑完就结束了。如果要在多次调用之间保留小的状态 (比如分页的游标、已处理的 id)，用 `store(key, value)` 和 `load(key)`。

沙箱本身不持久化任何东西。宿主在执行前把当前的值传进去，脚本成功后，宿主拿到"这次改了什么" (`storeWrites`)，写进会话的 custom entry。所以 store 的值**跟着分支走** (第 6 章、第 10 章)，恢复会话也能还原。失败的脚本不写入任何值。

## 17.7 动手

```bash
ANTHROPIC_API_KEY=... node src/main.ts --codemode
> 统计 src 下每个子目录有多少个 .ts 文件和多少行代码，用 codemode 一次完成
```

观察模型写的脚本，以及最终进入上下文的内容有多少。对比不用 `--codemode` 时的轮数和 token。

测试：

```bash
node --test test/advanced.test.ts
# ok - codemode: script calls tools; only its output reaches the model
# ok - codemode: beforeToolCall hooks apply inside scripts
```

## 17.8 什么时候适合用

code mode 不是总比普通 tool call 好：

- **适合**：批量操作、需要过滤大量输出、多步骤但逻辑确定的流程、工具数量很多；
- **不适合**：每一步都需要模型根据结果做判断的探索性任务。脚本一旦写好就按固定逻辑执行，中间出现意外情况，模型看不到，也没法调整；
- **代价**：模型要写出正确的代码。写错了，整个脚本失败 (已经执行的工具调用不会撤销)，要重写重跑。

pi 的默认设置是 codemode 和普通工具并存 (`codemode.mode: "on"`)，让模型自己选择。也可以设置成 `only`，所有工具都只能通过脚本调用。

## 练习

1. 用 `node:vm` 写一个逃逸的例子，证明 mini-harness 的 codemode 不安全。然后思考：用 `child_process.fork` 一个没有任何权限的子进程运行脚本，能解决问题吗？还缺什么？
2. 实现 `searchTools(query)`：按工具名和描述的关键词匹配打分，返回前 5 个。
3. 给 mini-harness 的工具加上 `outputSchema`，让 bash 在脚本里返回 `{ output, exitCode }`，而不是一段文字。
4. 设计一个评测：10 个批处理类任务，分别用普通模式和 codemode 完成，记录轮数、总 token、成功率。
