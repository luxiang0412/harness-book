# 从零构建 Agent Harness：以 pi 为蓝本

**在线阅读：<https://luxiang0412.github.io/harness-book/>** ｜ **PDF：[Releases](https://github.com/luxiang0412/harness-book/releases/latest)**

一本教你从零构建 agent harness 的书。以开源项目 [pi](https://github.com/earendil-works/pi) 为蓝本，每一章讲一个问题、看 pi 怎么解决、再在配套项目 mini-harness 里动手实现一个精简版本。

## 目录

| 章 | 标题 | 主要内容 |
|---|---|---|
| 0 | [导读：什么是 harness](chapters/00-introduction.md) | harness 的职责、pi 的分层、本书的读法 |
| **第一部分** | **基础：先跑起来** | |
| 1 | [和模型对话：统一的 LLM 接口](chapters/01-llm-interface.md) | 消息模型、流式事件、SSE、适配器、消息清洗、prompt cache |
| 2 | [最小的 agent loop](chapters/02-agent-loop.md) | 100 行的 agent、两层循环、事件序列、工具执行的三个阶段 |
| 3 | [工具：让模型动手](chapters/03-tools.md) | 截断、read、edit 的查找替换、bash 的进程管理、并发修改 |
| 4 | [Agent：状态、事件、中断与插话](chapters/04-agent-state.md) | 状态、订阅与背压、abort、steer / follow-up |
| **第二部分** | **变得可用** | |
| 5 | [上下文工程](chapters/05-context-engineering.md) | system prompt 分段、AGENTS.md、skills、模板、增量更新与缓存 |
| 6 | [会话：可分支的 JSONL 会话树](chapters/06-sessions.md) | 只追加、parentId 树、上下文重建、分支 |
| 7 | [上下文压缩](chapters/07-compaction.md) | 触发、切点、结构化摘要、溢出恢复 |
| **第三部分** | **交互与集成** | |
| 8 | [终端 UI：差分渲染](chapters/08-tui.md) | 转义序列、组件模型、差分算法、宽度、按键 |
| 9 | [一个核心，多种运行模式](chapters/09-modes.md) | print、JSON、RPC、SDK、启动流程 |
| 10 | [扩展系统：原理](chapters/10-extensions.md) | 加载、两阶段初始化、事件、合并规则、fail closed |
| 11 | [扩展实战与分发](chapters/11-extensions-practice.md) | 权限、plan mode、todo、git 检查点、子 agent、pi packages |
| 12 | [MCP：接入外部工具](chapters/12-mcp.md) | JSON-RPC、生命周期、工具桥接、exposure |
| **第四部分** | **生产级话题** | |
| 13 | [安全与项目信任](chapters/13-security.md) | 威胁模型、隔离、项目信任、纵深防御 |
| 14 | [模型管理、凭据与失败恢复](chapters/14-models-and-retry.md) | 模型目录、凭据、虚拟模型、错误分类、两层重试 |
| 15 | [Client/Server：把 harness 拆成服务](chapters/15-client-server.md) | 帧协议、attach、复制状态、远程执行 |
| 16 | [Durable 执行：崩溃之后接着跑](chapters/16-durable.md) | 意图日志、replay、任务、存储 |
| 17 | [Code Mode：让模型写脚本调用工具](chapters/17-codemode.md) | 沙箱、权限不可绕过、TypeScript 声明 |
| 18 | [测试与评估](chapters/18-testing-and-evals.md) | 假模型、时序控制、失败路径、evals |
| A | [mini-harness 代码地图](chapters/19-appendix-a-code-map.md) | |
| B | [术语表](chapters/20-appendix-b-glossary.md) | |
| C | [pi 源码阅读路线](chapters/21-appendix-c-reading-order.md) | |

## 目录结构

```text
harness-book/
├── README.md          本文件
├── chapters/          正文 (Markdown，mermaid 图直接写在文中)
├── diagrams/          手绘 SVG 图
├── mini-harness/      配套代码：TypeScript，零运行时依赖
├── build/             生成 HTML / PDF 的脚本和样式
├── .vitepress/        网站配置 (VitePress)
└── index.md           网站首页
```

## 运行 mini-harness

需要 Node.js 22.18 或更新版本 (直接运行 `.ts` 文件，不需要编译)。

```bash
cd mini-harness
node --test test/*.test.ts       # 31 个测试，离线运行
node src/main.ts --demo          # 不需要 API key，用假模型体验交互界面
ANTHROPIC_API_KEY=... node src/main.ts
```

更多用法见 [mini-harness/README.md](mini-harness/README.md) 和附录 A。

## 本地预览网站

```bash
npm ci --ignore-scripts
npm run dev        # http://localhost:5173/harness-book/
```

推送到 `main` 后，GitHub Actions 会运行 mini-harness 的测试、构建网站并发布到 GitHub Pages。

## 生成 PDF

```bash
./build/build.sh          # 生成 build/book.html 和 build/book.pdf
./build/build.sh html     # 只生成 HTML
```

依赖：

- [pandoc](https://pandoc.org/) 3.x；
- Google Chrome 或 Chromium (用来把 HTML 打印成 PDF，可以用环境变量 `CHROME` 指定路径)；
- 网络 (从 jsDelivr 加载 mermaid.js 渲染流程图)；
- 中文字体：样式表优先使用 Noto Sans CJK SC / Noto Serif CJK SC。

不需要 LaTeX。PDF 由浏览器渲染，中文、代码高亮和 mermaid 图都能正确显示。

## 写作约定

- pi 的源码路径都相对于 pi 仓库根目录，例如 `packages/agent/src/agent-loop.ts`。
- 书中引用的 pi 代码有删节，以说明设计为目的；完整代码以仓库为准。
- pi 的部分包 (durable、server、client、protocol) 标注为实验性，相关章节关注设计思路，API 可能变化。
