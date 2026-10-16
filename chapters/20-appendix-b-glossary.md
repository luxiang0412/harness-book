# 附录 B　术语表

按拼音或字母顺序排列。括号里是首次详细讲解的章节。

| 术语 | 解释 |
|---|---|
| abort (中断) | 用户主动停止当前 run。通过一个 AbortSignal 传给模型请求和所有工具 (4) |
| AbortSignal | JavaScript 的取消信号。调用 `AbortController.abort()` 后，所有监听它的操作停止 |
| adapter (适配器) | 在统一消息格式和某家 provider 的协议之间转换的代码 (1) |
| AGENTS.md | 写给 agent 看的项目说明文件，每次请求都会发送 (5) |
| agent loop | "请求模型 → 执行工具 → 再请求" 的循环 (2) |
| AgentMessage | agent 层的消息类型，比 LLM 消息多了摘要、扩展消息等应用自定义的类型 (2) |
| AgentSession | pi 中把 Agent、会话、压缩、扩展、重试组装在一起的类，所有运行模式共用 (4) |
| attach | 客户端连接到服务器上的某个会话。mini-harness 示例里的概念，pi 里对应获取一个对象的引用 (15) |
| attachmentId | mini-harness 示例里，服务器为每次 attach 生成的标识，请求必须携带，用于拒绝过期的请求 (15) |
| backpressure (背压) | 消费者处理慢时，让生产者也慢下来，避免数据在内存里堆积 (4) |
| bracketed paste (括号粘贴) | 终端把粘贴的内容用特殊序列包起来，程序能区分粘贴和按键 (8) |
| branch (分支) | 会话树上从某个旧节点长出的新路径 (6) |
| branch summary (分支摘要) | 离开一个分支时，对它的摘要，带到新分支上 (6) |
| chord | pi 的跨进程对象运行时：host、link、引用、复制状态、热更新，独立于其他 pi 包 (15) |
| code mode | 让模型写 JavaScript 脚本调用工具，只有脚本输出进入上下文 (17) |
| compaction (压缩) | 把旧的对话历史替换成摘要，释放上下文空间 (7) |
| context (上下文) | 一次模型请求的全部输入：system prompt、历史消息、工具声明 |
| context window (上下文窗口) | 模型单次请求能处理的最大 token 数 |
| context_edit | 会话里的一种 entry，改变某条历史消息在上下文中的样子，而不修改原始记录 (6) |
| continue | 不加新消息，从当前历史再请求一次模型，用于重试 (4) |
| cut point (切点) | 压缩时，保留部分的起点。只能落在 user 或 assistant 消息上 (7) |
| diff rendering (差分渲染) | 只重写屏幕上变化的行 (8) |
| durable (持久化执行) | 每一步都写入存储，进程崩溃后能从检查点继续 (16) |
| entry | 会话文件里的一行记录，有 id 和 parentId (6) |
| eval (评估) | 用真实模型跑真实任务，统计成功率、成本 (18) |
| event (事件) | harness 各层之间报告进展的方式，例如 `message_update`、`tool_execution_end` (2) |
| exposure | MCP 或扩展工具如何到达模型：direct、deferred、codemode、hidden (12) |
| extension (扩展) | 一个 TypeScript 模块，通过 ExtensionAPI 注册工具、命令、事件处理器 (10) |
| fail closed | 检查本身失败时按"不允许"处理 (10, 13) |
| faux provider (假模型) | 按剧本回复的假 provider，用于离线开发和测试 (1, 18) |
| follow-up (追加) | 排队等 agent 完成当前任务后再处理的消息 (4) |
| frame (帧) | 字节流协议里的一条完整消息，通常以长度前缀开头 (15) |
| frontmatter | Markdown 文件开头 `---` 之间的元数据 (5) |
| harness | 把只会生成文本的模型变成能完成任务的 agent 的那层程序 (0) |
| idempotent (幂等) | 执行多次和执行一次效果相同 (16) |
| intent (意图) | 执行有副作用的操作之前，先写入存储的"我要做 X"的记录 (16) |
| JSON Schema | 描述 JSON 数据结构的标准，用于工具参数声明 (3) |
| JSON-RPC | 基于 JSON 的远程调用协议，MCP 建立在它之上 (12) |
| JSONL | 每行一个 JSON 对象的文件格式 (6) |
| jiti | 在 import 时即时编译 TypeScript 的加载器，pi 用它加载扩展 (10) |
| leaf | 会话树上的当前位置 (6) |
| MCP | Model Context Protocol，工具服务器和客户端之间的开放协议 (12) |
| OAuth | 一种授权协议，用于订阅登录和远程 MCP 服务器 (12, 14) |
| orphaned tool call (孤儿 tool call) | 历史里没有对应结果的 tool call，发送前要补一个错误结果 (1) |
| overflow (溢出) | 请求超出上下文窗口 (7) |
| partial | 流式事件里携带的"到目前为止拼好的消息" (1) |
| pi package | 打包分发扩展、skill、模板、主题的 npm 包或 git 仓库 (11) |
| progressive disclosure (渐进式披露) | 只把目录放进上下文，正文按需加载 (5) |
| project trust (项目信任) | 决定是否加载项目目录里可执行的资源 (13) |
| prompt cache | provider 缓存请求的前缀，前缀不变时以折扣价复用 (1) |
| prompt injection | 攻击者把指令藏在模型会读到的内容里 (13) |
| prompt template (提示模板) | 可复用的用户消息，用 `/名字` 展开 (5) |
| provider | 模型服务提供方 (1) |
| QuickJS | 一个小型 JavaScript 引擎，pi 把它编译成 WebAssembly 作为 codemode 沙箱 (17) |
| raw mode | 终端的一种输入模式，每个按键立即送达程序 (8) |
| replay | 崩溃恢复时是否可以重新执行一个工具：`safe` 或 `never` (16) |
| replicated state (复制状态) | 服务端持有权威状态，客户端订阅快照和增量 (15) |
| reserveTokens | 给模型回复预留的上下文空间，压缩触发阈值的一部分 (7) |
| run | 从一条用户输入开始，到 agent 停下的全过程 (0) |
| section | system prompt 里一个有名字的段落，用 XML 标签包裹 (5) |
| skill | 包含 SKILL.md 的目录，按需加载的指令包 (5) |
| SSE | Server-Sent Events，流式 HTTP 响应的文本格式 (1) |
| steering (插话) | 运行中注入的消息，在当前工具执行完后、下一次请求前生效 (4) |
| stopReason | 模型停止的原因：stop、toolUse、length、error、aborted (1) |
| streaming (流式) | 模型边生成边返回 |
| synchronized output (同步输出) | 终端攒齐一帧再显示，消除闪烁 (8) |
| system prompt | 每次请求开头的指令文本 (5) |
| token | 模型计量文本的单位 |
| tool call | 模型发出的一次工具调用请求 (2) |
| transformMessages | 发送前清洗消息：补孤儿 tool call、丢弃失败消息、处理跨模型的 thinking (1) |
| truncation (截断) | 限制工具输出的长度，并告诉模型如何获取剩余部分 (3) |
| turn | 一次模型请求加上它引出的工具执行 (0, 2) |
| usage | 一次请求的 token 用量：input、output、cacheRead、cacheWrite (1) |
| virtual model (虚拟模型) | 用户选择的一个名字，每次请求由路由函数决定实际用哪个模型 (14) |
