# 第 18 章　测试与评估

> 本章对应 pi 的 `packages/ai/src/providers/faux.ts`、`packages/coding-agent/test/suite/`、`packages/evals`、`packages/telemetry`，mini-harness 的 `test/`。

## 18.1 问题：模型是不确定的

harness 的行为依赖模型的输出，而模型的输出每次都可能不同。这让测试变得棘手：

- 同一个测试，今天过了，明天可能就不过了；
- 测试要花钱，要网络，要 API key；
- 测试失败了，分不清是 harness 的 bug，还是模型这次"发挥不好"。

解法是把问题分成两类，用不同的方法处理：

| | harness 测试 | 评估 (eval) |
|---|---|---|
| 回答的问题 | harness 的逻辑对不对？ | 模型 + harness 能不能完成任务？ |
| 模型 | 假模型，按剧本回复 | 真实模型 |
| 结果 | 确定的：过或不过 | 统计的：成功率、成本 |
| 运行频率 | 每次修改代码 | 发布前、调整 prompt 或工具后 |
| 成本 | 零 | token 费用 + 时间 |

## 18.2 假模型

第 1 章介绍过 faux provider。它是 harness 测试的基础：按剧本回复，但完整地走一遍流式事件协议，harness 无法区分它和真实模型。

```typescript
const faux = createFauxModel([
  [toolCall("read", { path: "a.txt" })],                 // 第 1 次请求：调用工具
  (context) => {                                         // 第 2 次请求：根据上下文决定
    const last = context.messages.at(-1);
    assert.equal(last?.role, "toolResult");              // 顺便检查 harness 发了什么
    return "done";
  },
]);
```

几个用法：

- **固定内容**：测试 harness 对某种回复的处理 (比如 stopReason 为 length 时是否拒绝执行工具)；
- **函数**：根据请求内容动态回复，同时可以对请求做断言；
- **抛异常**：模拟 provider 错误 (`throw new Error("429 rate limit")`)，测试重试逻辑；
- **`faux.requests`**：记录了每次请求的完整上下文，可以检查 system prompt、工具列表、消息顺序；
- **小上下文窗口**：`createFauxModel(steps, { contextWindow: 4000 })`，几轮对话就能触发压缩。

pi 的仓库规则 (`AGENTS.md`) 明确要求：

> For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.

需要真实 API 的端到端测试放在另外的位置，只有设置了对应的环境变量才会运行。

## 18.3 测什么

### 事件顺序和状态

第 2 章的事件序列、第 4 章的状态更新，都是 harness 对外的契约。UI 和扩展依赖它们。mini-harness 的第一个测试就是检查最简单情况下的事件序列：

```typescript
assert.deepEqual(events.filter((t) => t !== "message_update"), [
  "agent_start", "turn_start",
  "message_start", "message_end",      // user
  "message_start", "message_end",      // assistant
  "turn_end", "agent_end",
]);
```

### 时序相关的行为

插话、中断、并发修改这类行为依赖时序，测试时要能精确控制"在某个时刻发生某件事"。常用的技巧是**门 (gate)**：一个由测试控制何时 resolve 的 Promise。

pi 的 `agent-session-queue.test.ts` 里有一个典型的写法：

```typescript
let releaseToolExecution: () => void;
const toolRelease = new Promise<void>((resolve) => { releaseToolExecution = resolve; });
const waitTool: AgentTool = {
  name: "wait",
  execute: async () => {
    await toolRelease;                    // 工具卡在这里，直到测试放行
    return { content: [{ type: "text", text: "released" }], details: {} };
  },
};
// 测试：等工具开始执行 → 在这个时刻插话 → 放行工具 → 检查插话出现的位置
```

mini-harness 的 "steering message is injected after the current tool batch" 用了同样的方法。

### 失败路径

harness 的大部分代码在处理失败：网络错误、参数错误、工具异常、扩展异常、上下文溢出、用户中断。每一条失败路径都应该有测试。mini-harness 的测试里，有一半以上在测失败路径：

| 测试 | 失败场景 |
|---|---|
| invalid arguments come back to the model | 参数校验失败 |
| beforeToolCall can block execution | 钩子阻止 |
| abort stops the stream | 用户中断 |
| bash returns isError on non-zero exit code | 命令失败 |
| HTTP errors become an error event | provider 返回 401 |
| orphaned tool calls get a synthetic result | 历史里有孤儿 tool call |
| extension that throws in tool_call blocks the tool | 扩展崩溃 |
| retryable error is retried with backoff | 429 |
| durable: interrupted tool calls | 进程崩溃 |

### provider 适配器

适配器不能用 faux 测试，因为要测的正是"把真实的协议转换成统一格式"。但也不需要调用真实 API：**录制真实的 SSE 响应，用本地 HTTP 服务器回放**。mini-harness 的 `test/providers.test.ts` 就是这样做的，还故意把响应切成 7 字节的小块发送，测试 SSE 解析的健壮性。

### 回归测试

修复一个 bug 时，先写一个能复现它的测试。pi 的仓库规则要求回归测试旁边注明 issue 编号：

> When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.

这样以后有人想删掉一个"看起来多余"的测试时，能找到它存在的原因。第 6 章看到的 `(#10000)` 注释就是这种做法在源码里的体现。

### TUI

第 8 章讲过：用 tmux 启动程序、发送按键、截取屏幕文本。这个方法也让 agent 自己能测试 TUI。

## 18.4 评估：模型 + harness 能不能完成任务

harness 测试保证逻辑正确，但回答不了这些问题：

- 把工具描述改短一点，模型的表现变好还是变坏了？
- 新加的 system prompt 规则有没有效果？
- 换一个模型，成功率下降了多少？
- 文档写得好不好，agent 能不能靠读文档完成任务？

这些都要用真实模型跑真实任务，统计结果。

### pi 的 evals

`packages/evals` 基于 `vitest-evals`。最简单的一个 eval (`evals/smoke.eval.ts`)：

```typescript
const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Answer a basic prompt", { harness }, (it) => {
  it("returns the expected answer", async ({ run }) => {
    const result = await run("What's the capital of France? Respond with only the city name.");
    expect(result.output.trim()).toBe("Paris");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
```

更有意思的是 **文档提升评估 (documentation lift)**：同一个任务，在两个环境里各跑一次：

- `without_docs`：删掉 pi 的 README、docs、examples，并去掉 system prompt 里指向文档的那一段；
- `with_docs`：完整的安装。

比较两者的成功率，差值就是"文档带来的提升"。比如 `extensions.docs.eval.ts` 的任务是"给正在运行的 pi 配置一个扩展，提供一个 hello 工具"，评判标准是扩展是否成功加载、工具是否被正确调用、返回值是否正确。

这个评估回答的是一个很实际的问题：第 5 章 system prompt 里的 `<docs>` 段，到底有没有用？

### 评估的工程细节

pi 的 evals runner 处理了很多容易被忽略的问题 (`packages/evals/README.md`)：

- **隔离**：每次运行都在一个全新的 Docker 容器里，有新的 home 目录、新的会话目录。评估定义和评分代码在 agent 运行前设为不可读，防止 agent "偷看答案"；
- **配对**：同一个任务的两个变体配成一对比较。任何一方出错 (而不是失败)，这一对就不计入统计，并且整体的成功率不显示，避免基于不完整的数据下结论；
- **重复**：默认每个变体跑一次，但报告会明确说明"一次运行无法确定稳定性"。需要时设置 `--runs-per-variant 5`；
- **顺序偏差**：多次重复时交替运行顺序；
- **完整记录**：保留每次运行的会话文件、用量数据，事后可以检查 agent 到底做了什么。

还有一条诚实的说明：

> Provider traffic still requires container network access, so Docker alone cannot prove that arbitrary code written by an agent never uses the network.

### 设计你自己的评估

1. **任务集**：从真实使用中收集，覆盖常见场景和已知的难点。10–30 个任务就能发现很多问题；
2. **评判**：能用确定的规则就不用模型评判。"测试通过了吗"、"文件内容对吗"、"调用了正确的工具吗" 都是确定的；
3. **指标**：成功率之外，记录轮数、token、花费、耗时。一个改动让成功率不变但 token 减半，也是很大的改进；
4. **隔离**：每次运行从干净的状态开始；
5. **对比**：评估的价值在于比较。改动前后各跑一次，或者两个变体配对比较。单独一个数字意义不大；
6. **重复**：模型有随机性，重要的结论要多跑几次。

## 18.5 可观测性

测试和评估之外，生产环境里还要能看到 harness 在做什么。

**会话文件就是最好的 trace。** 第 6 章的 JSONL 记录了每一条消息、每一次工具调用、每一次压缩、每一次模型切换。出问题时，第一件事是看会话文件。

pi 还有一个独立的 `packages/telemetry`，定义了与供应商无关的 telemetry 接口：span (一段操作的开始和结束)、属性、事件。pi 的各个包通过它报告"一次模型请求花了多久"、"一次工具调用的结果"。应用可以把它接到 OpenTelemetry、Sentry 或自己的日志系统。包里带有一个内存实现和一套一致性测试，自定义的适配器跑通测试就能保证行为正确。

## 18.6 mini-harness 的测试

```bash
cd harness-book/mini-harness
node --test test/*.test.ts
```

34 个测试，全部离线运行，几秒钟完成：

| 文件 | 覆盖 |
|---|---|
| `test/agent.test.ts` | 第 2–4 章：事件、工具、校验、钩子、插话、追加、中断、并发编辑、bash |
| `test/providers.test.ts` | 第 1 章：两个适配器 (本地 mock 服务器)、错误处理、消息清洗 |
| `test/session.test.ts` | 第 5–7、10、14 章：system prompt、AGENTS.md、skills、模板、会话树、文件读写、压缩、扩展、重试 |
| `test/advanced.test.ts` | 第 8、9、12、13、15–17 章：TUI 差分、MCP、信任、codemode、durable 恢复、RPC 子进程、会话服务器 |

## 练习

1. 为 mini-harness 写一个测试：模型回复 `stopReason: "length"` 且带有 tool call 时，工具不被执行。(提示：faux 模型目前总是返回 stop 或 toolUse，需要扩展它。)
2. 录制一次真实的 Anthropic 响应 (包括 thinking)，保存成文件，写一个回放测试。
3. 设计 5 个评估任务，用来比较 mini-harness 的 edit 工具 (查找替换) 和一个基于行号的 edit 工具。评判标准是什么？
4. 实现一个最简单的 eval runner：读一个任务列表 (prompt + 检查脚本)，对每个任务在临时目录里运行 `node src/main.ts -p`，运行检查脚本，输出成功率和总 token。
