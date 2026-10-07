# 附录 C　pi 源码阅读路线

读完本书后，如果想深入 pi 的源码，建议按下面的顺序。路径相对于 pi 仓库根目录。

## 第一站：核心循环 (约 3000 行)

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 1 | `packages/ai/src/types.ts` | 消息、事件、Model 类型。先只看前 800 行 |
| 2 | `packages/ai/src/utils/event-stream.ts` | 135 行，推拉之间的桥 |
| 3 | `packages/ai/src/utils/transcript.ts` | system 消息的回放、工具状态的差异 |
| 4 | `packages/agent/src/types.ts` | AgentMessage、AgentTool、AgentEvent、所有钩子的注释 |
| 5 | `packages/agent/src/agent-loop.ts` | **最重要的文件**，完整读一遍 |
| 6 | `packages/agent/src/agent.ts` | 状态、队列、生命周期 |

读完这一站，你就理解了 pi 的骨架。

## 第二站：一个完整的 provider

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 7 | `packages/ai/src/api/transform-messages.ts` | 发送前的清洗 |
| 8 | `packages/ai/src/api/anthropic-messages.ts` | `stream()`、`buildParams()`、`convertMessages()`、缓存控制 |
| 9 | `packages/ai/src/models.ts` | `Provider` 接口、`createProvider()`、`Models` |
| 10 | `packages/ai/src/providers/anthropic.ts` | 一个 provider 如何组装：认证 + 模型 + API |
| 11 | `packages/ai/src/providers/faux.ts` | 测试用的假模型 |

## 第三站：工具

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 12 | `packages/coding-agent/src/core/tools/truncate.ts` | 截断 |
| 13 | `packages/coding-agent/src/core/tools/read.ts` | 分页、可操作的提示 |
| 14 | `packages/coding-agent/src/core/tools/edit.ts` + `edit-diff.ts` | 查找替换、宽松匹配、保留原始格式 |
| 15 | `packages/coding-agent/src/core/tools/bash.ts` + `output-accumulator.ts` | 进程管理、有界内存 |
| 16 | `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | 61 行的并发控制 |

## 第四站：AgentSession 及其周边

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 17 | `packages/coding-agent/src/core/system-prompt.ts` | 230 行，分段与差异 |
| 18 | `packages/coding-agent/src/core/session-manager.ts` | 会话树、上下文重建 |
| 19 | `packages/coding-agent/src/core/compaction/compaction.ts` | 切点、摘要、token 估算 |
| 20 | `packages/coding-agent/src/core/messages.ts` | `convertToLlm()` |
| 21 | `packages/coding-agent/src/core/agent-session.ts` | 4000 行，按需查阅。先看 `_handleAgentEvent`、`prompt()`、`_installAgentToolHooks()`、重试和压缩相关的方法 |

## 第五站：扩展系统

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 22 | `packages/coding-agent/docs/extensions.md` | 先读文档 |
| 23 | `packages/coding-agent/examples/extensions/` | 挑 5–10 个示例读 |
| 24 | `packages/coding-agent/src/core/extensions/loader.ts` | 加载、两阶段初始化 |
| 25 | `packages/coding-agent/src/core/extensions/runner.ts` | 各种事件的合并规则 |
| 26 | `packages/coding-agent/src/core/extensions/types.ts` | 2000 多行，按需查阅 |

## 第六站：界面与模式

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 27 | `packages/tui/README.md` | 组件模型 |
| 28 | `packages/tui/src/tui-main-screen.ts` | `doRender()`：差分渲染的完整实现 |
| 29 | `packages/coding-agent/src/modes/print-mode.ts` | 170 行，最简单的模式 |
| 30 | `packages/coding-agent/src/modes/rpc/` | RPC 协议 |
| 31 | `packages/coding-agent/src/main.ts` | 启动流程 |

## 第七站：选读

按兴趣选择：

- **MCP**：`packages/mcp/src/client.ts`、`packages/coding-agent/docs/mcp.md`
- **安全**：`packages/coding-agent/docs/security.md`、`SECURITY.md`、`core/trust-manager.ts`
- **durable**：`packages/durable/README.md`、`packages/durable/docs/spec.md`
- **codemode**：`packages/codemode/README.md`、`packages/coding-agent/docs/codemode.md`
- **client/server**：`packages/protocol/README.md`、`packages/server/README.md`、`packages/chord/README.md`
- **评估**：`packages/evals/README.md`、`packages/evals/evals/`

## 阅读建议

1. **先看文档，再看代码。** pi 的 `packages/coding-agent/docs/` 写得很好，很多设计原因写在文档里。
2. **注释里有答案。** pi 的代码注释经常解释"为什么"，比如 `agent-loop.ts` 里关于 length 停止的注释、`session-manager.ts` 里关于 #10000 的注释。
3. **从测试倒推行为。** `packages/coding-agent/test/suite/` 里的测试用 faux 模型描述了各种场景下的预期行为，比读实现更容易理解。
4. **用 pi 读 pi。** 在 pi 仓库里启动 pi，问它"compaction 是在哪里触发的"。它会去读源码回答你。这也是检验你自己的 harness 好不好用的方法。
