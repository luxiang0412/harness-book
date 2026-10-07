import { withMermaid } from "vitepress-plugin-mermaid";

const chapter = (file: string, text: string) => ({ text, link: `/chapters/${file}` });

export default withMermaid({
	lang: "zh-CN",
	title: "从零构建 Agent Harness",
	description: "以 pi 为蓝本，从零构建一个 agent harness",
	base: "/harness-book/",
	cleanUrls: true,
	lastUpdated: true,
	// 站点源文件就是仓库根目录；代码和构建脚本不作为页面。
	srcExclude: ["README.md", "mini-harness/**", "build/**", "node_modules/**"],
	head: [["link", { rel: "icon", href: "/harness-book/favicon.svg" }]],
	markdown: {
		lineNumbers: false,
	},
	themeConfig: {
		nav: [
			{ text: "开始阅读", link: "/chapters/00-introduction" },
			{ text: "代码地图", link: "/chapters/19-appendix-a-code-map" },
			{ text: "下载 PDF", link: "https://github.com/luxiang0412/harness-book/releases/latest" },
		],
		sidebar: [
			{ text: "导读", items: [chapter("00-introduction", "0. 什么是 harness")] },
			{
				text: "第一部分：基础",
				items: [
					chapter("01-llm-interface", "1. 统一的 LLM 接口"),
					chapter("02-agent-loop", "2. 最小的 agent loop"),
					chapter("03-tools", "3. 工具"),
					chapter("04-agent-state", "4. 状态、事件、中断与插话"),
				],
			},
			{
				text: "第二部分：变得可用",
				items: [
					chapter("05-context-engineering", "5. 上下文工程"),
					chapter("06-sessions", "6. 会话树"),
					chapter("07-compaction", "7. 上下文压缩"),
				],
			},
			{
				text: "第三部分：交互与集成",
				items: [
					chapter("08-tui", "8. 终端 UI"),
					chapter("09-modes", "9. 多种运行模式"),
					chapter("10-extensions", "10. 扩展系统：原理"),
					chapter("11-extensions-practice", "11. 扩展实战与分发"),
					chapter("12-mcp", "12. MCP"),
				],
			},
			{
				text: "第四部分：生产级话题",
				items: [
					chapter("13-security", "13. 安全与项目信任"),
					chapter("14-models-and-retry", "14. 模型、凭据与重试"),
					chapter("15-client-server", "15. Client/Server"),
					chapter("16-durable", "16. Durable 执行"),
					chapter("17-codemode", "17. Code Mode"),
					chapter("18-testing-and-evals", "18. 测试与评估"),
				],
			},
			{
				text: "附录",
				items: [
					chapter("19-appendix-a-code-map", "A. mini-harness 代码地图"),
					chapter("20-appendix-b-glossary", "B. 术语表"),
					chapter("21-appendix-c-reading-order", "C. pi 源码阅读路线"),
				],
			},
		],
		outline: { level: [2, 3], label: "本页目录" },
		socialLinks: [{ icon: "github", link: "https://github.com/luxiang0412/harness-book" }],
		editLink: {
			pattern: "https://github.com/luxiang0412/harness-book/edit/main/:path",
			text: "在 GitHub 上编辑此页",
		},
		search: {
			provider: "local",
			options: {
				translations: {
					button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
					modal: {
						noResultsText: "没有找到结果",
						resetButtonTitle: "清除",
						footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
					},
				},
			},
		},
		docFooter: { prev: "上一章", next: "下一章" },
		lastUpdated: { text: "最后更新" },
		returnToTopLabel: "回到顶部",
		sidebarMenuLabel: "目录",
		darkModeSwitchLabel: "深色模式",
		footer: {
			message: "书中引用的 pi 源码版权归其作者所有，以 MIT 许可证发布：github.com/earendil-works/pi",
			copyright: "本书内容与代码以 CC0 1.0 发布 (公共领域)",
		},
	},
	mermaid: {
		theme: "neutral",
	},
});
