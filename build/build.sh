#!/usr/bin/env bash
# 生成 HTML 和 PDF。
#
#   ./build/build.sh          # 生成 build/book.html 和 build/book.pdf
#   ./build/build.sh html     # 只生成 HTML
#
# 依赖：pandoc (>= 3)、Chrome 或 Chromium、网络 (首次加载 mermaid.js)。
# 不需要 LaTeX：PDF 由 Chrome 打印 HTML 得到，中文和 mermaid 图都由浏览器渲染。

set -euo pipefail

BOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 输出放在 build/ 下，和 chapters/ 同一层级，章节里的 ../diagrams/*.svg 相对路径因此仍然有效。
OUT_DIR="$BOOK_DIR/build"

CHAPTERS=("$BOOK_DIR"/chapters/*.md)

pandoc "${CHAPTERS[@]}" \
	--from=markdown+east_asian_line_breaks \
	--to=html5 \
	--standalone \
	--toc --toc-depth=2 \
	--metadata title="从零构建 Agent Harness" \
	--metadata subtitle="以 pi 为蓝本" \
	--metadata lang=zh-CN \
	--css=book.css \
	--highlight-style=tango \
	--include-in-header="$BOOK_DIR/build/mermaid-header.html" \
	--resource-path="$BOOK_DIR/chapters" \
	--output="$OUT_DIR/book.html"

echo "HTML: $OUT_DIR/book.html"

if [[ "${1:-}" == "html" ]]; then
	exit 0
fi

CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
if [[ -z "$CHROME" ]]; then
	echo "Chrome/Chromium not found; set CHROME=/path/to/chrome" >&2
	exit 1
fi

# virtual-time-budget 让 Chrome 等待脚本 (mermaid 渲染) 完成后再打印。
"$CHROME" --headless=new --disable-gpu --no-sandbox \
	--no-pdf-header-footer \
	--virtual-time-budget=30000 \
	--run-all-compositor-stages-before-draw \
	--print-to-pdf="$OUT_DIR/book.pdf" \
	"file://$OUT_DIR/book.html" 2>/dev/null

echo "PDF:  $OUT_DIR/book.pdf"
