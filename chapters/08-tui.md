# 第 8 章　终端 UI：差分渲染

> 本章对应 pi 的 `packages/tui` 和 `packages/coding-agent/src/modes/interactive/`，mini-harness 的 `src/tui/` 和 `src/modes/interactive.ts`。

## 8.1 问题：console.log 不够用

一个 coding agent 的终端界面需要同时显示：

```text
› 修复 date.test.ts                        ← 历史
⏺ bash npm test                             ← 工具调用
  ⎿ FAIL src/date.test.ts (3 failed)        ← 工具输出 (执行中实时更新)
正在分析失败原因，问题出在时区处理上……       ← 模型正在流式输出的文字
──────────────────────────────────────────
> 顺便检查一下 utils.ts▌                     ← 输入框 (用户可以随时输入)
──────────────────────────────────────────
anthropic/claude-sonnet-5-5 · 23% · working  ← 状态栏
```

`console.log` 只能往下追加，做不到：

- 模型每生成一个字，就更新屏幕上**同一行**；
- 输入框和状态栏**固定在底部**，内容在上方增长；
- bash 输出实时刷新，结束后折叠成几行。

最朴素的做法是每次有变化就清屏重画。问题是：流式输出时每秒可能刷新几十次，长对话每次要重写几万个字符，屏幕会剧烈闪烁，终端也跟不上。

pi 有一个自己的终端 UI 框架 `packages/tui`，核心思想是**差分渲染**：只重写变化的部分。

## 8.2 终端基础

终端 UI 通过向 stdout 写入特殊的**转义序列**来控制光标和屏幕。常用的几个：

| 序列 | 作用 |
|---|---|
| `\x1b[nA` / `\x1b[nB` | 光标上移 / 下移 n 行 |
| `\r` | 光标回到行首 |
| `\x1b[2K` | 清除当前行 |
| `\x1b[J` | 清除光标位置到屏幕末尾 |
| `\x1b[2J\x1b[H` | 清屏，光标回到左上角 |
| `\x1b[3J` | 清除滚动历史 |
| `\x1b[31m` … `\x1b[39m` | 前景色设为红色 … 恢复默认 |
| `\x1b[?2026h` … `\x1b[?2026l` | **同步输出**：终端攒齐这一段再一次性显示 |
| `\x1b[?2004h` | 开启**括号粘贴**：粘贴的内容被 `\x1b[200~` 和 `\x1b[201~` 包起来 |

同步输出 (`2026`) 对消除闪烁很关键：没有它，终端可能在"清除了旧内容、还没写入新内容"的瞬间刷新屏幕。括号粘贴让程序能区分"用户粘贴了一段带换行的文字"和"用户敲了回车"，否则粘贴多行代码时，第一个换行就会把消息提交出去。

**输入**方面，终端默认是"行缓冲"模式：用户按回车后程序才收到整行。TUI 需要切换到 **raw 模式** (`process.stdin.setRawMode(true)`)，这样每个按键都会立即以字节序列的形式送达：

| 按键 | 字节 |
|---|---|
| 回车 | `\r` |
| 退格 | `\x7f` |
| Ctrl+C | `\x03` (raw 模式下不再触发 SIGINT，程序要自己处理) |
| Esc | `\x1b` |
| Alt+Enter | `\x1b\r` |
| 方向键上 | `\x1b[A` |

注意 Esc 和方向键都以 `\x1b` 开头。程序收到一个单独的 `\x1b` 时，要稍等片刻确认后面没有其他字节，才能判断用户按的是 Esc。pi 的 `stdin-buffer.ts` 专门处理这种拆分和合并。

### 主屏幕和备用屏幕

终端有两个缓冲区：

- **主屏幕**：平时用的那个，有滚动历史。程序退出后，输出还留在屏幕上。
- **备用屏幕** (alternate screen)：vim、less 用的那个。没有滚动历史，退出后恢复原来的屏幕内容。

pi 两种都支持：`TuiMainScreen` 在主屏幕里渲染，保留终端原生的滚动历史，用户可以用鼠标滚轮往上翻；`TuiAltScreen` 在备用屏幕里渲染，滚动由程序自己实现 (可以做固定高度的布局、搜索等)。默认是主屏幕。本章讲主屏幕的实现。

## 8.3 组件模型

pi-tui 的组件接口极其简单 (`packages/tui/src/tui.ts`)：

```typescript
interface Component {
  /** 按给定宽度渲染成若干行，每行一个字符串 (可以包含颜色序列) */
  render(width: number): string[];
  /** 获得焦点时处理键盘输入 */
  handleInput?(data: string): void;
  /** 主题变化等情况下清除缓存 */
  invalidate(): void;
}
```

没有虚拟 DOM，没有布局引擎，没有 diff 算法。组件只回答一个问题：**在这个宽度下，我长什么样？** 返回值是字符串数组，一个字符串对应屏幕上一行。

TUI 把所有组件的输出拼起来，就是整个界面。组件状态变化时，调用 `tui.requestRender()` 请求重新渲染。

## 8.4 差分渲染

### 算法

```text
上一帧：                    新一帧：
0  › 修复 date.test.ts      0  › 修复 date.test.ts
1  正在分析失败原因          1  正在分析失败原因，问题出在     ← 第一处变化 (firstChanged = 1)
2  ─────────────            2  时区处理上
3  > ▌                      3  ─────────────
4  ─────────────            4  > ▌
                            5  ─────────────
```

1. 比较新旧两帧，找到第一个不同的行 `firstChanged`；
2. 光标现在在上一帧的最后一行。上移 `(上一帧行数 - 1 - firstChanged)` 行；
3. `\r` 回到行首，`\x1b[J` 清除到屏幕末尾；
4. 写出新一帧从 `firstChanged` 开始的所有行。

整个过程包在同步输出里。流式输出时，变化的只有最后一条消息和下面的输入框、状态栏，每次只需要重写几行。

mini-harness 的 `src/tui/tui.ts`：

```typescript
render(): void {
  const width = this.terminal.columns;
  // 每行都按宽度折好，保证"一个字符串 = 屏幕上一行"
  const lines = this.children.flatMap((c) => c.render(width)).flatMap((l) => wrapText(l, width));

  if (width !== this.previousWidth) return this.fullRender(lines, true);   // 宽度变了：全部重画

  let firstChanged = -1;
  for (let i = 0; i < Math.max(lines.length, this.previousLines.length); i++) {
    if (lines[i] !== this.previousLines[i]) { firstChanged = i; break; }
  }
  if (firstChanged === -1) return;                                           // 没有变化

  const viewportTop = Math.max(0, this.previousLines.length - this.terminal.rows);
  if (firstChanged < viewportTop) return this.fullRender(lines, true);      // 变化在屏幕外：全部重画

  const cursorRow = this.previousLines.length - 1;
  let out = "\x1b[?2026h";
  if (firstChanged > cursorRow) {
    out += `\r\n${lines.slice(firstChanged).join("\r\n")}`;                 // 纯追加
  } else {
    const start = Math.min(firstChanged, lines.length - 1);
    if (cursorRow - start > 0) out += `\x1b[${cursorRow - start}A`;
    out += "\r\x1b[J" + lines.slice(start).join("\r\n");
  }
  out += "\x1b[?2026l";
  this.terminal.write(out);
  this.previousLines = lines;
}
```

### 两种必须全部重画的情况

**宽度变化。** 用户调整了终端窗口大小，所有长行的折行位置都变了，旧的行号对应关系全部失效。

**变化发生在屏幕外。** 光标只能在当前可见的区域内移动。如果第一处变化在已经滚出屏幕顶部的位置，就没法回去改它，只能清屏 (包括滚动历史) 后全部重画。

第二种情况给 UI 设计提了一个要求：**会变化的内容要尽量靠近底部**。流式输出的消息、输入框、状态栏都在最下面，所以绝大多数更新都是局部的。如果在屏幕顶部放一个每秒刷新的计时器，每一帧都会触发全部重画。

pi 的 `tui-main-screen.ts` 处理了更多情况：内容变短时清除多余的行、终端内嵌图片 (Kitty 图形协议) 占用多行、Termux 上软键盘弹出导致的高度变化等。它还有一个调试开关 `PI_TUI_DEBUG_REDRAW=1`，记录每次全部重画的原因。

### 合并渲染请求

流式输出时，一秒内可能有上百个 text_delta 事件。如果每个事件都立即渲染，大部分工作都是浪费。`requestRender()` 只是设置一个标志，用 `setImmediate` 推迟到当前同步代码执行完：

```typescript
requestRender(): void {
  if (this.renderScheduled) return;
  this.renderScheduled = true;
  setImmediate(() => {
    this.renderScheduled = false;
    this.render();
  });
}
```

同一个事件循环周期内的多次请求合并成一次渲染。

## 8.5 宽度：没有看上去那么简单

差分渲染依赖一个前提：**准确知道每个字符串在屏幕上占几列**。算错了，折行位置就错了，行号对不上，屏幕会出现残影和错位。

- **颜色序列不占宽度**：`\x1b[31mhello\x1b[39m` 只占 5 列；
- **中文、日文、韩文占 2 列**：`中文ab` 占 6 列；
- **emoji** 大多占 2 列，但组合 emoji (👨‍👩‍👧) 由多个码点组成，只占 2 列；
- **制表符**的宽度取决于所在位置。

mini-harness 的 `src/tui/text.ts` 处理了前两种。pi 的实现 (`packages/tui/src/utils.ts`) 更完整，并且在折行时会把颜色状态带到下一行，否则一段红色文字折行后，第二行会变回默认颜色。

对中文用户来说，宽度处理是检验一个终端 UI 质量的好方法：在输入框里输入一段中英文混排的长句，看光标位置和折行是否正确。

## 8.6 处理输入

### 快捷键要可配置

pi 不在代码里写死按键判断，而是按**动作名**查询：

```typescript
// packages/coding-agent/src/modes/interactive/components/custom-editor.ts
if (this.keybindings.matches(data, "app.interrupt")) { ... }
```

默认绑定定义在 `packages/tui/src/keybindings.ts` 和 `packages/coding-agent/src/core/keybindings.ts`，用户可以在 `~/.pi/agent/keybindings.json` 里修改。比如 `app.message.followUp` 默认是 Alt+Enter，但在 Windows 和 WSL 上 Alt+Enter 经常被终端占用，所以默认改成 Ctrl+Q。

mini-harness 用同样的结构 (`src/tui/keys.ts`)：

```typescript
export const DEFAULT_KEYBINDINGS: Record<KeyAction, string[]> = {
  submit: ["\r"],
  followUp: ["\x1b\r"],   // Alt+Enter
  abort: ["\x1b"],        // Esc
  exit: ["\x03"],         // Ctrl+C
  ...
};
```

### Kitty 键盘协议

传统的终端按键编码有很多歧义：Ctrl+I 和 Tab 发送同样的字节，Shift+Enter 和 Enter 无法区分。Kitty 键盘协议是一个现代扩展，用更完整的编码表示每个按键和修饰键。pi 会检测终端是否支持，支持就启用 (`packages/tui/src/keys.ts`)。

## 8.7 把事件变成界面

交互模式 (pi 的 `interactive-mode.ts`，约 7000 行) 做的事情可以概括为一张映射表：

| SessionEvent | 界面变化 |
|---|---|
| `message_start` (user) | 在历史区追加一条用户消息组件 |
| `message_update` (assistant) | 更新正在流式输出的消息组件 |
| `message_end` | 消息组件定稿 |
| `tool_execution_start` | 显示工具调用 (名称、参数) 和加载动画 |
| `tool_execution_update` | 更新实时输出 |
| `tool_execution_end` | 显示结果 (成功 / 失败)，长输出折叠 |
| `compaction_start` / `_end` | 显示压缩进度 |
| `auto_retry_*` | 显示"第 2 次重试，3 秒后" |
| `agent_end` | 状态栏回到空闲 |

每个工具可以自定义渲染 (`renderCall` / `renderResult`)：edit 显示彩色 diff，bash 显示命令和输出的最后几行，read 显示文件名和行数。扩展注册的工具也可以提供自己的渲染器。

mini-harness 的 `src/modes/interactive.ts` 是这张表的精简版：

```typescript
private onEvent(event: SessionEvent): void {
  switch (event.type) {
    case "message_start":
    case "message_update":
      if (event.message.role === "assistant") this.chat.streaming = event.message;
      break;
    case "message_end":
      this.chat.streaming = undefined;
      this.chat.messages = [...this.session.messages];
      break;
    case "tool_execution_update":
      this.chat.toolOutput.set(event.toolCallId, contentText(event.partialResult.content));
      break;
    // ...
  }
  this.updateFooter();
  this.tui.requestRender();
}
```

**交互模式不包含任何 agent 逻辑。** 它只做两件事：把按键转成对 AgentSession 的调用，把 AgentSession 的事件转成组件状态。下一章会看到，正是这种分离让同一个 AgentSession 能驱动完全不同的界面。

### 扩展需要和用户交互时

扩展可能需要问用户问题，比如第 11 章的权限确认："要执行 `rm -rf build/` 吗？" 交互模式要为扩展提供 UI 能力。pi 的 `ExtensionUIContext` 包括 `select`、`confirm`、`input`、`notify`，以及自定义组件、覆盖层等更多能力。mini-harness 的实现很朴素：把问题显示在输入框上方，用户下一次提交的内容就是答案。

## 8.8 性能

长会话可能有上千条消息。每帧都重新渲染所有消息组件，即使最终只输出几行差异，计算本身也很慢。几个优化方向：

- **组件缓存**：内容和宽度都没变时，直接返回上次的结果。pi 的 Markdown 组件缓存了解析结果和渲染结果 (`cachedText`、`cachedWidth`、`cachedLines`)；
- **只有最后一条消息在变**：流式输出时，前面的消息都是定稿的；
- **合并渲染请求**：8.4 节。

mini-harness 每帧都重新渲染全部消息，对演示足够，长会话时会变慢。

## 8.9 怎么测试 TUI

TUI 很难用普通的单元测试覆盖。pi 的做法是用 tmux：在一个固定大小的虚拟终端里启动程序，发送按键，然后截取屏幕内容检查。pi 仓库里有一个专门的 skill 描述这个流程 (`.pi/skills/interactive-testing.md`)：

```bash
tmux new-session -d -s test -x 80 -y 24
tmux send-keys -t test "node src/main.ts --demo" Enter
sleep 2 && tmux capture-pane -t test -p
tmux send-keys -t test "hello 世界" Enter
sleep 1 && tmux capture-pane -t test -p
tmux kill-session -t test
```

这个方法让 agent 自己也能测试 TUI：它可以运行这些命令，读取截屏文本，判断界面是否正确。

差分渲染算法本身可以用一个假终端做单元测试 (mini-harness 的 "tui: CJK width and differential rendering")：记录写入的内容，检查只改了一行时没有重写其他行。

## 8.10 动手

```bash
node src/main.ts --demo
```

试试这些操作：

- 输入中英文混排的长句，观察折行；
- 输入 `please read the readme`，观察工具调用的显示；
- 调整终端窗口宽度，观察全部重画；
- `/help` 查看命令。

相关文件：

| 文件 | 内容 |
|---|---|
| `src/tui/tui.ts` | 差分渲染、合并渲染请求 |
| `src/tui/text.ts` | 宽度计算、折行、颜色 |
| `src/tui/keys.ts` | 可配置的快捷键 |
| `src/tui/components.ts` | 对话、输入框、状态栏 |
| `src/modes/interactive.ts` | 事件 → 组件，按键 → session 调用，内置命令 |

## 8.11 省略了什么

pi-tui 和交互模式里还有大量 mini-harness 没有实现的东西：

- 完整的多行编辑器：光标移动、单词跳转、撤销、kill ring (Emacs 风格的剪切板)、历史记录；
- 自动补全：文件路径 (`@` 引用文件)、斜杠命令；
- Markdown 渲染、代码高亮、LaTeX；
- 终端内嵌图片 (Kitty、iTerm2 协议)；
- 覆盖层 (弹出式选择列表、对话框)；
- 备用屏幕模式、鼠标滚动、搜索；
- 主题系统。

## 练习

1. 给 mini-harness 的 ChatView 加上缓存：已经定稿的消息只渲染一次。用一个 500 条消息的会话测量渲染时间的差别。
2. 实现括号粘贴：开启 `\x1b[?2004h`，粘贴的内容里的换行不应该触发提交。
3. 让输入框支持左右方向键移动光标。光标不在末尾时，怎样在差分渲染里正确显示它？(提示：pi 在渲染结果里嵌入一个光标标记，渲染完成后再把硬件光标移过去。)
4. 故意在 ChatView 的顶部加一行每秒变化的时钟，用 `fullRedraws` 计数器观察会发生什么。
