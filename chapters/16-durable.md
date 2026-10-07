# 第 16 章　Durable 执行：崩溃之后接着跑

> 本章对应 pi 的 `packages/durable` (README 和 `docs/spec.md`)，mini-harness 的 `src/durable/recovery.ts`。
>
> pi-durable 标注为 **Experimental**，API 会变化。本章关注它的核心规则。

## 16.1 问题：进程死了，任务怎么办

前面所有章节的 harness，状态都在内存里。会话文件 (第 6 章) 记录了**已完成**的消息，但下面这些状态只在内存里：

- 模型正在流式生成的回复；
- 正在执行的工具；
- 队列里的 steering 和 follow-up 消息；
- 当前在第几次重试。

进程在任何时刻都可能死掉：笔记本合盖、OOM、服务器重新部署、用户按了 Ctrl+C 两次。用一个具体的时刻看看会发生什么：

```text
user:      "给所有 120 个客户发送续费提醒邮件"
assistant: [toolCall send_batch(customers 1-40), toolCall send_batch(41-80), toolCall send_batch(81-120)]
           ── 第一个 batch 发完了，第二个发到一半，进程崩溃 ──
```

重启后，会话文件里有 assistant 的这条消息，但三个 tool call 都没有结果。现在怎么办？

- 全部重新执行？客户 1–40 会收到两封邮件，41–80 中的一部分也会。
- 全部放弃？81–120 的客户永远收不到。
- 让模型决定？模型不知道哪些发出去了。

对于一个只在终端里跑几分钟的 coding agent，这种情况可以接受：用户看着，出问题了手动处理。但如果 agent 在服务器上无人值守地运行几个小时，或者它的工具有真实世界的副作用 (发邮件、付款、部署)，就必须严肃对待。

## 16.2 核心规则：先提交，再显示，再执行

pi-durable 的规范 (`docs/spec.md`) 把核心规则写在开头：

> A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.

拆开来说：

1. **所有状态变化都是原子提交 (commit)。** 追加一条消息、更新一个文档、创建一个任务，可以放在同一个提交里，要么全部写入存储，要么全部不写。
2. **只有提交过的状态才能被看到。** UI 显示的、工具读到的，都是已经写入存储的状态。不存在"屏幕上显示了，但存储里没有"的情况。
3. **有副作用的操作之前，先提交"意图"。** 这是避免 16.1 节问题的关键。

## 16.3 意图日志：区分"没开始"和"没完成"

回到发邮件的例子。如果在执行每个工具**之前**，先把"我要执行 tool call X"写进存储：

```text
assistant: [call A, call B, call C]
intent(A)
result(A)            ← A 完成
intent(B)            ← B 开始了
── 崩溃 ──           ← B 没有结果；C 连 intent 都没有
```

重启后，状态是清楚的：

| tool call | 存储里有什么 | 结论 | 怎么做 |
|---|---|---|---|
| A | intent + result | 已完成 | 什么都不做 |
| B | 只有 intent | 已开始，不知道是否完成 | 看工具是否可以安全重跑 |
| C | 什么都没有 | 从未开始 | 直接执行 |

B 是唯一的难题。pi-durable 的规则：

> Each call runs as its own durable task. Its intent is committed before `execute()` runs. If the process dies mid-call, the tool reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result with the output committed so far.

**`replay: "safe"`** 表示这个工具是幂等的：执行两次和执行一次效果相同。读文件、查询、计算都是安全的。发邮件、付款、追加写文件不是。

不安全的工具不重跑，而是给模型一个 `interrupted` 错误结果，附上崩溃前已经提交的输出 (比如 bash 已经打印了 "sent 23/40")。模型拿到这些信息，可以去检查实际状态 (查发送日志)，再决定怎么继续。**把不确定性如实交给模型，比 harness 自己猜要好。**

这条规则也解释了第 2 章 loop 里 `AgentTool` 类型上那个看起来多余的字段：

```typescript
// packages/agent/src/types.ts
/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
replay?: "never" | "safe";
```

## 16.4 一切都是任务

pi-durable 把 harness 的每一个步骤建模成**持久化的任务 (task)**：一个在每一步都保存检查点的状态机。进程重启后，任务从最后一个检查点继续。

一次问答在 pi-durable 里是这样的 (README 的 Concepts 一节)：

```text
submit(input) → pi.user                                          用户消息
  pi.generation → pi.system (仅当 prompt 或工具变化), pi.assistant (tool calls)
    pi.tool × n → pi.tool-result × n   (由 generation 拥有，generation 等待它们完成)
  pi.generation → pi.assistant (回答) → submission done
```

- `pi.generation` 任务：调用模型。它拥有本轮的所有 `pi.tool` 任务，等它们都完成后，把 run 交给下一个 generation；
- `pi.tool` 任务：执行一个 tool call；
- 任务之间有**所有权**关系：父任务等待子任务；中止时自底向上，先中止子任务，再执行父任务自己的中止逻辑，每个任务负责撤销自己的副作用。

和第 2 章的 loop 对比：loop 是一段连续执行的代码，状态在调用栈里；durable harness 把这段代码拆成了若干个可以独立恢复的步骤，状态在存储里。

### 流式输出怎么办

模型的流式回复每秒可能产生几十个增量。每个增量都提交一次，存储扛不住。pi-durable 的默认做法是：**部分回复和工具输出最多每 100 毫秒提交一次**。崩溃最多丢失 100 毫秒的输出。存储在远程时可以调大间隔。

### 提交请求的幂等性

客户端提交一个输入，网络断了，不知道服务器有没有收到。重新提交可能导致同一个问题被问两次。pi-durable 的解法是 `requestId`：

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// 重启后，同一个 requestId 找到的是同一个 submission，不会创建新的
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

这和第 15 章的"断线不重放"是同一个问题的两面：要么客户端只重放安全的操作，要么服务器让重放变得安全 (幂等)。

## 16.5 存储

pi-durable 支持几种存储后端：

| 后端 | 特点 |
|---|---|
| 内存 | 不持久化，用于测试 |
| SQLite | 一个数据库文件。WAL 模式：进程崩溃不丢提交，断电可能丢最后一个 |
| JSONL | 一个目录下的追加文件，可选每次提交前 fsync |
| Cloudflare Durable Object | 运行在 Cloudflare 上的 SQLite |

所有后端共享一套**一致性测试** (`registerStorageConformance`)。实现一个新的后端，跑通这套测试，就能确信它满足 harness 的要求。这是给可替换组件定义契约的好方法。

注意 SQLite 一行里的细节：WAL + `synchronous = NORMAL` 意味着进程崩溃是安全的，但操作系统崩溃或断电时，最后一次提交可能丢失。持久化有不同的强度，文档里明确写出保证到哪一级，使用者才能做出正确的选择。

## 16.6 其他能力

README 里还有几个值得了解的设计：

- **视图 (view)**：UI 需要的一切都是已提交的状态。`viewState()` 返回一个 chord 复制状态 (第 15 章)，包括对话记录、正在运行的生成和工具 (`pi.live`)、收件箱 (`pi.inbox`)、用量 (`pi.usage`)。远程客户端订阅它，就能实时看到 agent 在做什么。
- **收件箱**：会话繁忙时提交的输入进入收件箱。和第 4 章一样分 steer 和 follow-up，另外还有 `reject` (繁忙时直接拒绝) 和 `write` (只追加一条记录，不触发模型)。
- **子 agent**：一个工具可以创建一个**被任务拥有**的子会话。工具任务被中止时，子会话也被中止。因为子会话的创建和工具的意图在同一个提交里，崩溃后重跑这个工具 (`replay: "safe"`) 能找回同一个子会话，而不是再创建一个。
- **reset 和 handoff**：`reset()` 开始一个新的上下文，旧的记录仍然保存。可以带一段交接说明 ("我们在修复登录测试，继续")，这是一种比压缩更粗粒度的上下文管理。

## 16.7 mini-harness 的演示

mini-harness 没有实现完整的 durable 架构，`src/durable/recovery.ts` 只演示 16.3 节的核心规则：

```typescript
/** 包装工具：执行前先把意图写进会话文件。 */
export function withIntentLog(tool, session: SessionManager): AgentTool {
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      session.appendCustom(TOOL_INTENT, { toolCallId, name: tool.name });   // 先提交意图
      return tool.execute(toolCallId, args, signal, onUpdate);              // 再执行
    },
  };
}

/** 重启后：找最后一条带 tool call 的 assistant 消息，补齐缺失的结果。 */
export async function recoverInterruptedToolCalls(session, tools): Promise<RecoveryReport> {
  // ... 找到 assistant 消息，收集已有结果 (answered) 和已开始的意图 (started)
  for (const call of calls) {
    if (answered.has(call.id)) continue;                                    // 已完成
    const tool = tools.find((t) => t.name === call.name);
    const canRun = tool && (!started.has(call.id) || tool.replay === "safe");
    if (canRun) {
      // 从未开始，或者可以安全重跑：执行
    } else {
      // 开始了但不知道结果，且不能重跑：返回 interrupted 错误
    }
  }
}
```

它利用了第 6 章会话文件的性质：assistant 消息在 `message_end` 时就已经写入，早于工具执行。所以即使崩溃，会话文件里也一定有这条 assistant 消息。

测试 "durable: interrupted tool calls are rerun only when safe" 模拟了崩溃：`send_email` 登记了意图但没有结果，`lookup` (声明了 `replay: "safe"`) 从未开始。恢复后，`lookup` 被执行，`send_email` 得到 interrupted 错误，邮件没有发两次。

## 16.8 和 mini-harness 架构的差距

mini-harness (以及 pi 的 coding-agent) 的会话文件只记录完成的消息，而 pi-durable 记录的是**完整的状态机**。差距在这些地方：

| 状态 | mini-harness | pi-durable |
|---|---|---|
| 完成的消息 | 会话文件 | 提交的 entry |
| 正在流式生成的回复 | 只在内存 | 每 100ms 提交一次 |
| 工具执行意图 | 演示版本 | 每个工具都是一个任务 |
| 工具的部分输出 | 只在内存 | 提交 |
| 排队的消息 | 只在内存 | 收件箱文档 |
| 重试状态 | 只在内存 | 任务检查点 |
| 原子性 | 每行独立追加 | 多个变化一起提交 |

把一个已有的 harness 改造成 durable 的，难度主要在于：原来"一段连续执行的 async 函数"要拆成"可以从任意检查点恢复的状态机"。这也是为什么 pi 把它做成了一个独立的包，而不是在 coding-agent 上修补。

## 练习

1. 把 `withIntentLog` 接进 mini-harness 的 main.ts，并在 `--continue` 恢复会话时调用 `recoverInterruptedToolCalls`，然后自动 `agent.continue()`。用一个 `sleep 30` 的 bash 命令测试：运行中 `kill -9` 进程，再用 `-c` 恢复。
2. 给 mini-harness 的四个内置工具标注 `replay`。bash 应该标什么？有没有办法让某些 bash 命令被识别为安全的？
3. 在 mini-harness 的 AgentSession 里，steering 队列只在内存里。设计一种方式把它持久化到会话文件里，恢复时还原。
4. 读 pi-durable 的 `docs/spec.md` 第 1 节，列出它定义的所有不变量 (invariants)，选一条，说明违反它会导致什么问题。
