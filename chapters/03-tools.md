# 第 3 章　工具：让模型动手

> 本章对应 pi 的 `packages/coding-agent/src/core/tools/`，mini-harness 的 `src/tools/`。

## 3.1 问题：工具设计决定 agent 的表现

上一章的最小 agent 里，`read` 工具就是一行 `readFileSync(path)`。用它读一个 3 万行的日志文件会怎样？

- 3 万行大约 40 万 token，超过大多数模型的上下文窗口，请求直接失败；
- 即使窗口够大，这一轮要花几美元，而且之后每一轮都要重新发送这 40 万 token；
- 模型被淹没在无关内容里，回答质量下降。

再比如 `edit` 工具，如果设计成"把第 42 行替换成 xxx"，模型数行号经常数错，而且第一处修改后，后面的行号全变了。

**工具是模型和世界交互的唯一接口。** 工具的参数设计、输出格式、错误信息，会直接影响模型能不能完成任务。工具的描述文字也会进入上下文，它本身就是 prompt 的一部分。

## 3.2 工具的两部分

一个工具由两部分组成：

```typescript
// 发给模型的声明
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// harness 执行的部分
interface AgentTool extends Tool {
  execute(toolCallId: string, args: Args, signal?: AbortSignal, onUpdate?: (partial) => void): Promise<AgentToolResult>;
}

interface AgentToolResult {
  content: (TextContent | ImageContent)[];  // 给模型看的
  details?: unknown;                        // 给 UI / 日志看的，不发给模型
  isError?: boolean;
  terminate?: boolean;
}
```

`content` 和 `details` 的分离很重要。以 edit 工具为例：

- `content`：`"Successfully replaced 2 block(s) in src/app.ts."` —— 模型只需要知道成功了；
- `details`：完整的 diff —— UI 用它显示彩色的修改对比。

如果把 diff 也放进 content，每次修改都会往上下文里塞几十行模型自己刚写的内容，纯属浪费。

pi 在 `AgentTool` 之上还有一层 `ToolDefinition` (`packages/coding-agent/src/core/extensions/types.ts`)，多了几个字段：

| 字段 | 作用 | 章节 |
|---|---|---|
| `label` | UI 显示名 | — |
| `promptSnippet` | system prompt 里的一行简介 | 第 5 章 |
| `promptGuidelines` | 这个工具自带的使用规则 | 第 5 章 |
| `prepareArguments` | 校验前修正参数格式 | 第 2 章 |
| `executionMode` | 是否允许并行 | 第 2 章 |
| `outputSchema` | 结构化输出的 schema，给 code mode 用 | 第 17 章 |
| `renderCall` / `renderResult` | 自定义终端渲染 | 第 8 章 |

`wrapToolDefinition()` (`tools/tool-definition-wrapper.ts`) 把 ToolDefinition 转成 agent 层能用的 AgentTool。这种分层让 `packages/agent` 不依赖任何 UI 或 prompt 相关的概念。

## 3.3 为什么默认只有四个工具

pi 默认启用的工具只有四个：`read`、`bash`、`edit`、`write`。另外有 `grep`、`find`、`ls` 可选启用。

为什么不多给一些？比如 `git_status`、`run_tests`、`search_web`？

因为 **bash 已经能做几乎所有事**。模型对 shell 命令非常熟悉，`git status`、`npm test`、`rg TODO` 它都会用。每多一个专用工具，就要多一段描述进入每次请求的上下文，模型还要多做一次选择。

那为什么 read、edit、write 要单独做成工具，而不是让模型用 `cat`、`sed`、`echo >`？因为在这几件事上，专用工具明显比 shell 做得好：

| 操作 | 用 shell | 用专用工具 |
|---|---|---|
| 读大文件 | `cat` 一次全部输出，撑爆上下文 | 自动分页，提示"用 offset=2001 继续" |
| 读图片 | `cat` 输出二进制乱码 | 作为图片附件发给模型 |
| 改代码 | `sed` 的转义规则复杂，模型经常写错 | 精确文本替换，失败时给出明确原因 |
| 写文件 | heredoc 遇到特殊字符会出错 | 内容原样写入 |

这是一个通用的原则：**专用工具只在"比 shell 明显更好"时才值得存在**。pi 的 system prompt 里也有对应的规则：只有 bash 没有 grep/find/ls 时，告诉模型 "Use bash for file operations like ls, rg, find"；有 read 工具时，告诉模型 "Use read to examine files instead of cat or sed"。

## 3.4 输出截断

所有可能产生大量输出的工具都要截断。pi 的规则 (`tools/truncate.ts`)：

- **两个独立上限，先到先生效**：2000 行，或 50KB；
- **读文件用 head 截断**：保留开头。文件开头通常有 import、类定义，最重要；
- **命令输出用 tail 截断**：保留结尾。编译错误、测试失败摘要、命令结果都在最后；
- **不返回半行**：避免截断在一个 UTF-8 多字节字符中间，或者截出半个 JSON。

截断本身不难，难的是**截断之后告诉模型什么**。对比两种提示：

```text
[output truncated]
```

```text
[Showing lines 1-2000 of 31337. Use offset=2001 to continue.]
```

第一种，模型不知道被截了多少、怎么看剩下的部分，可能会换个方式 (比如 `cat`) 再读一次，结果又被截断。第二种直接告诉它下一步怎么做。pi 的每个截断提示都是这种**可操作**的形式。

bash 的截断提示还会给出完整输出的保存位置：

```text
[Showing lines 1832-2000 of 2000. Full output: /tmp/pi-bash-a1b2c3.log]
```

模型如果需要看中间某段，可以 `grep` 或者 `read` 这个文件，而不是重新运行一遍可能很耗时的命令。

mini-harness 的 `src/tools/truncate.ts`：

```typescript
export function truncateTail(content: string, maxLines = 2000, maxBytes = 50 * 1024): TruncationResult {
  const lines = splitLines(content);
  if (lines.length <= maxLines && byteLength(content) <= maxBytes) {
    return { content, truncated: false, ... };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {          // 从后往前收集
    if (kept.length >= maxLines) break;
    const lineBytes = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      if (kept.length === 0) kept.unshift(lines[i].slice(-maxBytes));   // 最后一行本身就超长
      break;
    }
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }
  return { content: kept.join("\n"), truncated: true, totalLines: lines.length, outputLines: kept.length, ... };
}
```

**字节数要按 UTF-8 计算**，不能用 `string.length`。一个中文字符在 JS 里 length 为 1，但占 3 个字节，token 数也更多。

## 3.5 read

pi 的 read 工具 (`tools/read.ts`) 有几个值得学习的细节。

**分页参数是 1-indexed 的行号。** `offset: 2001` 表示从第 2001 行开始。模型习惯用编辑器里看到的行号，用 0-indexed 会频繁差一。

**超长单行的退路。** 一个压缩过的 JS 文件可能整个就一行，几 MB。按行截断后什么都不剩。pi 返回：

```text
[Line 1 is 2.3MB, exceeds 50.0KB limit. Use bash: sed -n '1p' bundle.js | head -c 51200]
```

工具承认自己处理不了，并告诉模型用另一个工具绕过去。

**图片。** 如果文件是图片 (通过魔数检测，不是看扩展名)，作为 `ImageContent` 返回，模型可以"看到"截图。pi 还会按模型的限制自动缩放图片。如果当前模型不支持图片，附上一句说明，避免模型以为读到了内容。

**可替换的底层操作。** 所有文件工具都通过一个 `operations` 接口访问文件系统：

```typescript
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}
```

默认实现是本地文件系统。换成 SSH 实现，同一个 read 工具就能读远程机器上的文件。第 15 章的远程执行环境就是这么接入的。

## 3.6 edit：精确文本替换

edit 是 coding agent 里最关键、也最难设计好的工具。

### 为什么是"查找并替换"

修改文件的协议有几种选择：

| 协议 | 例子 | 问题 |
|---|---|---|
| 行号 | "把 42-45 行替换成…" | 模型数行号不可靠；多处修改时行号会漂移 |
| unified diff | `@@ -42,4 +42,5 @@` | 模型写的上下文行经常和文件对不上 |
| 整文件重写 | write 整个文件 | 大文件浪费 token，还容易顺手改坏别处 |
| 查找替换 | `oldText → newText` | 要求 oldText 精确匹配 |

pi 和大多数 coding agent 都选择了查找替换。它的失败模式最清晰：要么找到了唯一的一处，要么报告"找不到"或者"找到多处"。两种失败都容易解释给模型。

### pi 的参数设计

```typescript
{
  path: string,
  edits: Array<{ oldText: string, newText: string }>
}
```

一次调用可以包含多处修改。规则 (直接写在工具描述和 promptGuidelines 里)：

1. 每个 `oldText` 必须在**原文件**中唯一出现；
2. 所有 `oldText` 都相对于**原文件**匹配，而不是依次应用 (前一处修改不影响后一处的匹配)；
3. 各处修改不能重叠；
4. `oldText` 尽量短，只要能保证唯一即可。

第 2 条值得解释。如果按顺序应用，模型必须在脑子里模拟"第一处改完后文件长什么样"才能写出第二处的 oldText，这很容易出错。相对原文件匹配，模型只需要看着当前文件内容写。

### 失败信息是写给模型看的

```text
Could not find edits[1] in src/app.ts. The oldText must match exactly including all whitespace and newlines.

Found 3 occurrences of edits[0] in src/app.ts. Each oldText must be unique. Please provide more context to make it unique.

edits[0] and edits[2] overlap in src/app.ts. Merge them into one edit or target disjoint regions.
```

每条都说明了出了什么问题、该怎么改。

### 宽松匹配

模型复述代码时常有一些细微差异：行尾多了或少了空格、把 `'` 写成 `'`、把 `-` 写成 `—`。pi 的做法是先精确匹配，失败后再做一次规范化匹配 (`tools/edit-diff.ts` 的 `normalizeForFuzzyMatch`)：

```typescript
text.normalize("NFKC")
  .split("\n").map((line) => line.trimEnd()).join("\n")     // 去掉行尾空白
  .replace(/[‘’‚‛]/g, "'")               // 弯引号 → 直引号
  .replace(/[“”„‟]/g, '"')
  .replace(/[‐-―−]/g, "-")                    // 各种破折号 → -
  .replace(/[  -   　]/g, " "); // 各种特殊空格 → 空格
```

宽松匹配有一个副作用要处理：如果直接在规范化后的文本上替换再写回，文件里**其他行**的行尾空格也会被删掉，产生一大片无关的 diff。pi 的 `applyReplacementsPreservingUnchangedLines()` 只替换被修改的行，其余行保留原始字节。mini-harness 为简洁省略了这一步，并在注释里注明。

### 保留文件的原始格式

- **换行符**：Windows 文件用 CRLF。匹配前统一成 LF，写回时恢复成 CRLF。
- **BOM**：有些文件以不可见的 BOM 字符开头，模型的 oldText 里不会有它。匹配前剥离，写回时加上。

这些细节不处理，用户会发现 agent 改了一行代码，git diff 却显示整个文件都变了。

## 3.7 bash

bash 工具 (`tools/bash.ts`) 看起来只是 `spawn("bash", ["-c", command])`，但要做对需要处理不少问题。

**合并 stdout 和 stderr。** 按到达顺序交错输出，和人在终端里看到的一样。分开返回的话，模型看不出哪条错误对应哪一步。

**流式更新。** `npm install` 可能跑一分钟。执行过程中通过 `onUpdate` 把已有输出推给 UI，并节流 (pi 的 `BASH_UPDATE_THROTTLE_MS`)，避免每收到一个字节就刷新一次。

**杀掉整个进程树。** 用户中断或超时时，只杀 bash 进程是不够的：`npm test` 启动的 node 进程会变成孤儿继续运行。做法是用 `detached: true` 让子进程成为新进程组的组长，然后 `process.kill(-pid)` 杀掉整个组。

```typescript
const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
const kill = () => process.kill(-child.pid!, "SIGKILL");   // 负 pid = 整个进程组
signal?.addEventListener("abort", kill, { once: true });
```

**stdin 设为 ignore。** 如果命令等待输入 (比如 `git commit` 打开编辑器，或者某个交互式确认)，它会永远挂起。关掉 stdin 后，这类命令会立即失败，模型能看到错误并换一种方式。

**退出码。** 非 0 退出码时返回 `isError: true`，并在内容末尾加上 `Command exited with code 1`。模型据此判断成败，而不用从输出文字里猜。

**有界内存。** 一个命令可能输出几 GB (比如不小心 `cat` 了一个大文件)。pi 的 `OutputAccumulator` 只在内存里保留尾部，输出超过阈值时把完整内容流式写进临时文件。mini-harness 简化为全部收集在内存里。

**环境变量。** pi 会给命令设置 `PI_SESSION_ID`、`PI_MODEL` 等环境变量，这样模型调用的脚本可以知道自己运行在哪个会话里。

**可定制。** `commandPrefix` 在每条命令前加一段 (比如 `source .venv/bin/activate`)；`spawnHook` 可以改写命令、工作目录和环境变量；`operations` 可以把执行转发到远程机器或容器。

## 3.8 并发修改同一个文件

第 2 章说过，pi 默认并行执行同一批 tool call。如果模型在一条回复里对同一个文件发了两个 edit：

```text
edit#1  读 a.ts (v0)
edit#2  读 a.ts (v0)        两者都基于 v0
edit#1  写 a.ts (v1 = v0 + 修改1)
edit#2  写 a.ts (v2 = v0 + 修改2)   ← 修改1 丢了
```

pi 的解决方案是 `withFileMutationQueue()` (`tools/file-mutation-queue.ts`)：按文件路径排队，同一个文件的修改串行执行，不同文件之间仍然并行。

```typescript
const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpath(path);          // 用真实路径，避免通过符号链接绕过
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  queues.set(key, previous.then(() => current));   // 后来者排在我后面

  await previous;                            // 等前一个修改完成
  try {
    return await fn();
  } finally {
    release();                               // 放行下一个
  }
}
```

还有一个细节：`realpath` 是异步的。两个调用同时开始计算 key，后发起的可能先算完，抢先排进队列，顺序就反了。pi 用一个 `registrationQueue` 让"登记"这一步本身也串行执行。mini-harness 的 `src/tools/mutation-queue.ts` 保留了这个处理。

测试 "parallel edits to the same file do not lose updates" 验证了这个场景：两个并行的 edit 分别修改 `one` 和 `two`，最终文件是 `ONE\nTWO\n`。

## 3.9 工具描述就是 prompt

看看 pi 的 read 工具描述：

> Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

它告诉了模型：能读什么、限制是多少、超过限制怎么办。从这里可以总结出写工具描述的几条经验：

1. **说明限制。** 告诉模型输出会被截断，它就会主动用 offset 分页，而不是反复尝试。
2. **说明失败时怎么办。** "When you need the full file, continue with offset until complete."
3. **参数描述要具体。** `"Line number to start reading from (1-indexed)"` 比 `"offset"` 好得多。
4. **用法规则放进 promptGuidelines，而不是塞进描述。** 描述说明"这个工具是什么"，规则说明"什么时候该用它"。第 5 章会看到它们如何进入 system prompt。

## 3.10 动手

mini-harness 的工具实现：

| 文件 | 内容 |
|---|---|
| `src/tools/truncate.ts` | head / tail 截断 |
| `src/tools/read.ts` | 分页读取，可操作的截断提示 |
| `src/tools/write.ts` | 写入文件，自动创建目录 |
| `src/tools/edit.ts` | 多处替换、唯一性检查、重叠检查、宽松匹配、CRLF 保留 |
| `src/tools/bash.ts` | 进程组、超时、中断、流式更新、退出码、尾部截断 |
| `src/tools/mutation-queue.ts` | 同文件修改排队 |
| `src/agent/validate.ts` | 参数校验 |

运行相关测试：

```bash
node --test test/agent.test.ts
# ok - coding tools: write, edit, read
# ok - parallel edits to the same file do not lose updates
# ok - bash returns isError on non-zero exit code
```

在交互模式里试试截断：

```bash
node src/main.ts --demo
> please read the readme
```

或者接真实模型，让它读一个大文件，观察它如何使用 offset 分页。

## 3.11 省略了什么

- **grep / find / ls 工具**：pi 用 ripgrep 和 fd 实现，自动遵守 `.gitignore`，并对匹配行长度做截断。
- **图片读取与缩放**。
- **自定义渲染器**：pi 的每个工具都有 `renderCall` / `renderResult`，在终端里显示语法高亮的 diff、可折叠的输出等。
- **结构化输出**：`outputSchema` 和 `structuredContent`，供 code mode 脚本使用 (第 17 章)。
- **PowerShell 工具**：Windows 上的 bash 替代。
- **宽松匹配时保留未修改行的原始字节**。

## 练习

1. 给 mini-harness 加一个 `grep` 工具，调用 `rg --json`，每行匹配最多 500 字符，总共最多 100 条。截断提示应该怎么写？
2. 把 bash 工具改成：输出超过 1MB 时只在内存里保留尾部，完整内容流式写入临时文件 (参考 pi 的 `OutputAccumulator`)。
3. edit 工具目前在宽松匹配时会删掉整个文件的行尾空格。实现"只替换被修改的行"。
4. 设计一个实验：同一个任务，分别给模型 (a) 只有 bash，(b) bash + read + edit + write。比较完成的轮数和 token 消耗。
