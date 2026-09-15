# vendor/dsh —— 来自 deepseek-harness 的 UI 积木

## 许可

MIT License

Copyright (c) 2026 DeepSeek

上游：<https://github.com/deepseek-ai/deepseek-harness>
路径：`packages/client/ui-primitives/src/`
检出提交：`0d1f500`

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 这份拷贝的规矩

**除下面点名的五个文件外，每个文件都逐字取自上游**，顶上压着一行出处（路径 + 提交号）。
这样做是为了将来还能重新同步：改动只要还锁在那五个文件里，重新拉一遍上游就是覆盖，
而不是一场三方合并。要改样式请改 `tokens.css`，不要改进 `*.module.css`。

### 不是上游的五个文件

| 文件 | 是什么 |
| --- | --- |
| `NOTICE.md` | 本文件 |
| `index.ts` | 上游 `index.ts` 删到只剩留下那批之后的版本 |
| `tokens.css` | `--dsw-*` → 我们 `--color-*` 的桥接表，文件里标了哪些值是猜的 |
| `markdown/katex-lazy.ts` | **我们自己写的**：把 katex 引擎和它的样式表包成一个异步模块 |
| `highlighted.ts` | **我们自己写的**第二个入口，装会拖进 shiki 的那几块，理由写在文件顶上 |

### 逐字之外的改动

1. **`ansi.ts` / `head-tail-cap.ts` 不在这个目录里。** `TerminalBlock.tsx` 和
   `SearchBlock.tsx` 改指 `frontend/src/shared/terminal-text/` 下已有的那一份——两条
   import 行，旁边标了 `ROOST-CHANGE`。那份拷贝的颜色映射换成了我们的主题令牌（所以它
   **不**逐字，不适合放进这个目录），配套测试是 `frontend/tests/ansi.test.ts`，75 个用例。
   搬第二份的代价是两份会各自漂移，而测试只钉着其中一份。
2. **markdown 渲染树已经整棵搬进来了**（第二轮）。第一轮曾用一个纯文本替身顶着，理由是
   它要拖 12 个 npm 包；后来推翻了那个取舍——正文排版是对话观感的大头。三处
   `ROOST-CHANGE`：`katex.tsx` 的引擎改成按需注入、`MarkdownText.tsx` 去掉样式表的静态
   import、`MarkdownText.module.css` 末尾加一条 `list-style-type: revert`（Tailwind 的
   preflight 把 `ul/ol` 的标记清零了，而上游这份 CSS 依赖浏览器默认值，不加就是所有列表
   的序号和圆点全不见）。

3. **两处是被我们自己的 CSS reset 逼出来的**，上游没有这两条：

   - `markdown/MarkdownText.module.css` 末尾的 `list-style-type: revert`——Tailwind 的
     preflight 有 `ol, ul, menu { list-style: none }`，而上游这份 CSS 从头到尾不提
     `list-style`（它只要浏览器默认值），不加就是**所有列表的序号和圆点全不见**。
   - `user-text.module.css` 里 `.refIcon` 的 `display: inline`——preflight 把 `svg` 设成
     `display: block`，引用芯片会被拆成「图标一行、文字一行」。

   **这是个模式**：上游那批 CSS 建立在它自己的 reset 之上，搬到我们的 reset 上必然缺一块。
   而且两次都是 typecheck 和测试看不出、只有画出来才发现。以后再搬带 inline svg 或列表的
   组件，先照着截图查一遍。

4. **`MessageItem.module.css` 删掉了上游的 52–193 行**——那 20 条 `.compaction*` 已经在
   `chat/CompactionItem.module.css` 里，搬第二份会让两处各自漂移。

5. **`WebBlock` 在 `highlighted.ts` 而不是 `index.ts`。** 它自己不碰 shiki，但它用
   `MarkdownText` 画搜索结果正文，而完整树里 `render.tsx → CodeBlock → markdown/highlight.ts`
   是静态引用——「谁 import 谁」的隔离只要有一次间接引用就破。实测：桶里只取一个
   `TerminalBlock`，挪之前 shiki 会跟着进来，挪之后 shiki 和 katex 都是 0 次、产物 154 KB。

## 搬了什么

### 第一轮：积木（上游 `packages/client/ui-primitives/src/`）

`DiffBlock` `TerminalBlock` `ReadBlock` `SearchBlock` `WebBlock` `CodeBlock` `JsonBlock`
`DisclosureRow` `StateDot` `Pill` `FoldToggle`，以及它们的依赖闭包：

- 工具：`clipboard.ts`、`use-copy-feedback.ts`、`css-modules.d.ts`
- 语法高亮：`markdown/highlight.ts`、`markdown/useViewportHighlighting.ts`（走 `shiki`）
- 图标：`icons/index.tsx`、`icons/props.ts`（`DisclosureRow` 要 `IconChevronDownOutline14`）
- `WebBlock` 的链接图标一路：`LinkIcon.tsx` → `FileTypeIcon.tsx` → `CodeFileIcon.tsx`
  → `code-file-icon-artwork.ts` + `.manifest.json` + `code-file-types.ts`
  （`.manifest.json` 不能写注释，出处只记在这里）

### 第二轮起：对话外壳与消息体（上游 `packages/client/ui-chat/src/client/`）

从「搬几个零件、外壳还是我们自己的」改成**整半边换掉**之后搬进来的：

- 容器与正文：`chat/ChatView.tsx`、`chat/AssistantMarkdown.tsx`、`markdown/` 整棵渲染树
- 消息体与装饰：`chat/MessageItem.tsx`、`ReasoningRow.tsx`、`chat/CompactionItem.tsx`、
  `chat/MessageIconActions.tsx`、`user-text.tsx`、`ReferenceIcon.tsx`
- 回合统计：`chat/TurnProcessNodeView.tsx`、`chat/TurnUsagePanel.tsx`（两个药丸）、
  `chat/TurnNavigator.tsx`，以及它们共用的 `chat/stat-dialog.ts`、
  `chat/message-chrome.ts`、`chat/token-format.ts`、`chat/use-calendar-day.ts`、
  `chat/searchable-hidden.ts`、`file-size.ts`、`accessibility.module.css`
- 命令卡片：`chat/GenericCommandCard.tsx`、`chat/CompactionCommandCard.tsx`
- 工具卡片（这一撮的上游是 **`packages/client/ui-tool/src/client/`**，不是 `ui-chat`）：
  `chat/tool/ToolRow.tsx`，七个 `chat/tool/models/*`，以及 `chat/tool/toolviews/` 里的
  `GenericToolCard` `file-mutation-row` `read-row` `read-family-row` `bash-sample`

**其中 `TurnNavigator` 搬了但没接**：它的价值随回合数上涨，而我们是一次读完整段历史、
不做增量滚动，接上去是个永远指着同一处的导航条。留在目录里是为了将来改成增量加载时不用重搬。

## 没搬什么

上游有、这里故意不要的（搬之前 grep 过，留下的文件没有任何一个引用它们）：

- 品牌与外壳：`BrandWordmark` `FishLogo` `ConnectionIndicator` `OnboardingSurface`
- 通用控件：`Button` `Input` `Switch` `Tag` `Menu` `Modal` `Toast` `Tooltip`
  `HoverCard` `RiskConfirmation` `JsonTree` ~~`ReferenceIcon`~~（第二轮随 MessageItem 搬入） ~~`user-text`~~（第二轮随 MessageItem 搬入）
- 定位与杂项 hook：`useAnchoredMaxHeight` `useAnchoredPosition`
  `useDismissOnOutsidePointer` `pointer-grace` `relative-time` `rank-by-name` ~~`file-size`~~（第二轮随 MessageItem 搬入）
- `markdown/plain-text.ts`——闭包里没人引它
- **`ask-question-row.tsx` + `ask-question-card-model.ts` + `raw-tool-call.ts`
  + `AskQuestionCard`**：它们读的是上游那套审批往返的信封，我们的 transcript 里根本没有
  审批这回事，接上去是**言之凿凿的空壳**——有标题有边框，里面永远没内容。
  `auto-review-denial.ts` `primitive-labels.ts` 同理。
- **`search-row` `web-row` `todo-row` `read-image-row` + `plan-summary.ts`：还没搬，但不是
  「不该搬」。** 曾经在这里写过一条理由说它们要上游的工具结果信封——**那是错的**，已更正：
  逐个查过 import，这四个只依赖 `tool-call-model` / `web-card-model` / `search-card-model` /
  `image-card-model` / `read-family-row`，而这五个我们**都已经搬了**。
  真正的未知在数据形状：`web-card-model` / `search-card-model` 要从 `resultRaw` 里解析出
  结构（搜索结果条目、匹配行），而我们的 `ToolBlock.result` 是各家 CLI 落盘的原始文本，
  对不对得上没验过。**接之前先拿真实记录跑一遍 model，对不上再按规矩不接、回来补记。**
  `todo-row` 只读 `argsRaw`（就是我们的 `ToolBlock.args`），数据是够的。
- `ui-tool` 的外壳与接线：`ToolCallTree` `AskQuestionCard` `apply.ts` `contract/slots.ts`
  `locale.ts` `index.ts`——那是上游的插槽运行时，我们的分派写在
  `features/conversations/tools/dispatch.ts` 里。

## 运行时依赖

`react`、`clsx`、`diff`、`anser`、`shiki`（`@shikijs/langs` 由 `shiki` 带入），
以及 markdown 树要的一串：`katex`、`micromark-core-commonmark`、`micromark-extension-gfm`、
`micromark-extension-math`、`micromark-factory-space`、`micromark-util-{character,
classify-character,symbol,sanitize-uri}`、`mdast-util-{from-markdown,gfm,math}`
（类型侧另有 `micromark-util-types`、`@types/mdast`）。连传递依赖共 57 个包。

**katex 是按需加载的**：引擎 75.7 KB gz + 样式表 7.9 KB gz，只在第一条公式出现时才取；
它还带 59 个字体文件（合计 1.02 MB raw）进 `assets/`，浏览器只取用到字形的那几张。
markdown 树本身的净代价是 +65.0 KB gz，落在对话那个懒加载 chunk 里，首屏一字节未动。
