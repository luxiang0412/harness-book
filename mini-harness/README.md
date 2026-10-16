# mini-harness

《从零构建 Agent Harness》的配套代码。一个能实际使用的 coding agent harness，结构和 [pi](https://github.com/earendil-works/pi) 一一对应，约 6000 行 TypeScript (含大量中文注释)，零运行时依赖。

## 要求

Node.js 22.18 或更新版本。Node 直接运行 `.ts` 文件，不需要编译或安装依赖。

## 快速开始

```bash
node --test test/*.test.ts              # 34 个测试，离线运行
node src/main.ts --demo                 # 假模型，体验交互界面
```

接真实模型 (任选一个)：

```bash
ANTHROPIC_API_KEY=...  node src/main.ts
OPENAI_API_KEY=...     node src/main.ts -m openai/gpt-4.1
DEEPSEEK_API_KEY=...   node src/main.ts -m deepseek/deepseek-chat

# 任何 OpenAI 兼容服务 (Ollama、vLLM、LM Studio…)
MINI_BASE_URL=http://localhost:11434/v1 MINI_MODEL=qwen2.5-coder:7b MINI_CONTEXT_WINDOW=32000 node src/main.ts
```

其他模式：

```bash
node src/main.ts -p "解释这个目录"               # print 模式
node src/main.ts --mode json "解释这个目录"      # JSON 事件流
node src/main.ts --mode rpc                      # RPC 模式 (stdin/stdout JSONL)
node src/main.ts -c                              # 继续最近的会话
node src/main.ts -e examples/extensions/plan-mode.ts   # 加载扩展
node src/main.ts --codemode                      # 启用 codemode 工具
```

## 交互模式

| 操作 | 按键 / 命令 |
|---|---|
| 发送 | Enter (运行中 = 插话) |
| 追加任务 | Alt+Enter |
| 中断 | Esc |
| 退出 | Ctrl+C (运行中先中断) |
| 换行 | Ctrl+J |
| 命令 | `/help`、`/compact`、`/model`、`/tree`、`/branch`、`/tools`、`/session`、`/quit` |

## 配置

`~/.mini/` (可用 `MINI_HOME` 覆盖)：

```text
~/.mini/
├── settings.json        { "defaultModel": "anthropic/claude-sonnet-5-5", "compaction": {...}, "retry": {...} }
├── AGENTS.md            全局指令
├── SYSTEM.md            替换默认 system prompt
├── APPEND_SYSTEM.md     追加到 system prompt
├── mcp.json             MCP 服务器
├── extensions/          扩展 (*.ts)
├── skills/              skills (*/SKILL.md)
├── prompts/             prompt 模板 (*.md)
├── trust.json           项目信任决定
└── sessions/            会话文件
```

项目目录下的 `.mini/` 结构相同，需要信任后才加载。

## 源码结构

```text
src/
├── ai/            统一的 LLM 接口：消息、流式事件、Anthropic / OpenAI / faux 适配器
├── agent/         agent loop、Agent 状态
├── tools/         read、write、edit、bash
├── context/       system prompt、AGENTS.md、skills、模板
├── session/       会话树 (JSONL)、AgentSession
├── compaction/    上下文压缩
├── extensions/    扩展系统
├── mcp/           MCP 客户端
├── tui/           差分渲染的终端 UI
├── modes/         交互、print、json、rpc
├── codemode/      脚本调用工具 (node:vm，仅演示，不是安全边界)
├── durable/       崩溃恢复演示
├── trust.ts       项目信任
├── resources.ts   资源发现
├── config.ts      配置
└── main.ts        入口
```

每个文件开头的注释说明了它对应书的哪一章、pi 的哪个文件。完整对照表见书的附录 A。

## 类型检查

项目本身没有依赖。需要类型检查时，临时安装 TypeScript：

```bash
npm install --no-save typescript @types/node
npx tsc -p tsconfig.json
```

## 局限

这是教学项目。和 pi 相比，省略了大量生产环境需要的东西，每一章末尾都列出了省略的内容。特别注意：

- `codemode` 用 `node:vm` 运行脚本，**不是安全边界**；
- 没有内置的权限确认，工具以你的用户权限运行。参考第 13 章，在隔离环境里使用。
