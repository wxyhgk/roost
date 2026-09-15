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

**除下面点名的八个文件外，每个文件都逐字取自上游**，顶上压着一行出处（路径 + 提交号）。
这样做是为了将来还能重新同步：改动只要还锁在那八个文件里，重新拉一遍上游就是覆盖，
而不是一场三方合并。要改样式请改 `tokens.css`，不要改进 `*.module.css`。

### 不是上游的八个文件

| 文件 | 是什么 |
| --- | --- |
| `NOTICE.md` | 本文件 |
| `index.ts` | 上游 `index.ts` 删到只剩留下那批之后的版本 |
| `tokens.css` | `--dsw-*` → 我们 `--color-*` 的桥接表，文件里标了哪些值是猜的 |
| `markdown/katex-lazy.ts` | **我们自己写的**：把 katex 引擎和它的样式表包成一个异步模块 |
| `highlighted.ts` | **我们自己写的**第二个入口，装会拖进 shiki 的那几块，理由写在文件顶上 |
| `chat/CompactionItem.module.css` | 从 `MessageItem.module.css` 52–193 行抽出来的那 20 条 `.compaction*` |
| `layout/index.ts` | layout 的桶，上游没有对应物（它的外壳靠 slot 注册表装配，没有桶） |
| `layout/layout-state.ts` | 上游 `stores.ts` 的布局那一半，`defineStore` → `useReducer`，并加了持久化 |

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

4. **我们自己的 `index.css` 静默干掉了上游的滚动条内缩。** `frontend/src/index.css` 有一条
   无层的 `* { scrollbar-width: thin; scrollbar-color: … }`。上游 `scrollbar.css` 的注释把这件事
   写得很死：非 `auto` 的 `scrollbar-width`/`scrollbar-color` 会让 Chromium 和 Safari 对该元素
   **丢弃全部 `::-webkit-scrollbar*` 规则**。所以 `ConversationRoot.module.css` 的
   `.scrollBody::-webkit-scrollbar-track { margin: 2px }` 和 `InputBar.module.css` 的
   `.scroll::-webkit-scrollbar-track { margin-top: 8px }` 在我们这儿是**空转**的。
   后果纯观感（滚动条不内缩 2px、滑块顶到卡片圆角里），module.css 保持逐字不动；真要修就改
   `index.css` 那条全局规则，那是独立决定。

   **这是 NOTICE 第 3 条那个模式的新变种**：前两次是 Tailwind 的 preflight 撞车，这次肇事者
   是我们自己写的全局规则。同样是 typecheck 和单测看不见的一类。

5. **布局状态我们持久化，上游故意不。** 上游 README 写着 "Layout state resets on reload"，
   刷新即重置栏宽和折叠态（只有对话内容宽存 localStorage）。我们不跟这一条——口子是
   `layout-state.ts` 的 `LayoutPersistence`，默认不启用。**只存 `sidebar` / `rightbar` 两个
   字段**：`viewportWidth` 是实测值；`narrowExpanded` 上游自己跨断点就清，存下来等于把临时
   动作变成永久偏好；右栏那几个 `shown/track/fullscreen` 是占位者报上来的派生装饰，存了会在
   刷新后变成「框以为开着、占位者以为关着」。读回来的值重新夹逼一次——存储里可能躺着旧版本
   写的或手改的值，一个 NaN 进 `gridTemplateColumns` 就是一条永远修不好的坏栏。

6. **`MessageItem.module.css` 删掉了上游的 52–193 行**——那 20 条 `.compaction*` 已经在
   `chat/CompactionItem.module.css` 里，搬第二份会让两处各自漂移。

7. **`WebBlock` 在 `highlighted.ts` 而不是 `index.ts`。** 它自己不碰 shiki，但它用
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

### 第三轮：应用外壳（上游 `packages/client/ui-layout/src/client/`）

前两轮搬的是「一条消息长什么样」，这一轮搬的是**装它的那个框**——在此之前我们是在自己的
外壳上接别人的零件，形状始终对不上。

- `layout/columns.ts`——**逐字**，57 行零 import。整套栏宽契约：`CENTER_MIN=400`
  `SIDEBAR_MIN/MAX/DEFAULT/COLLAPSED=264/420/280/56` `SIDEBAR_AUTO_COLLAPSE=1024`
  `RIGHTBAR_MIN=300` `RIGHTBAR_MAX_RATIO=0.7` `RIGHTBAR_DEFAULT_RATIO=0.45`，以及
  `clampWidth` / `computeColumns`。**让步顺序是硬的**：右栏先缩到 300 → 整轨消失 →
  中栏这才允许掉破 400 → 左栏永不让步。`frontend/tests/dsh-columns.test.ts` 钉着它。
- `layout/AppFrame.module.css`——**逐字**，99 行。
- `layout/AppFrame.tsx`——`DragHandle` 逐字，框主体改接线（六处 ROOST-CHANGE，见文件头）。

### 第三轮之二：对话列骨架（上游 `packages/client/ui-conversation/src/client/skeleton/`）

前两轮搬的是「一条消息长什么样」，这一块是**装消息的那个壳**：

- `skeleton/ConversationRoot.module.css`（481 行）——**逐字**，1 处 ROOST-CHANGE。最值钱的
  一份：内容宽度轴 `clamp(680px, 栏宽 × 0.64, 920px)`、76px 的头（这个数等于右栏标签条 38
  加窗格头 38，两条规则在栏边接得上）、唯一滚动容器 `.scrollBody`、滚动容器**内部**的
  sticky 座位、hero 态、两条 40px 宽度拖条。
- `skeleton/HeroShell.module.css`（231 行）、`skeleton/InputBar.module.css`（394 行）——**逐字**。
  后者**搬了没接**：我们的 `ConversationComposer` 还是自己那套，接它是另一件事。
- `skeleton/ConversationShell.tsx` / `ConversationContent.tsx`——改自上游的
  `ConversationMainPanel` / `ConversationContent`，`WidthHandle` 和两段 ResizeObserver 逐字。

**这一块补上了一个一直缺的东西**：`--dsh-conversation-column-width` 在此之前**全仓没有任何
地方发布过**，于是内容宽度轴恒等于 clamp 的下限 680px——消息列和栏宽脱钩，栏拉多宽都是 680。
`ConversationShell` 的 `publishWidths` 正是发布它的那一段。接上之后实测：栏宽 1280 →
正文列 819px（0.64 × 1280）、输入卡 851px，两者正好差 32。

### 第三轮之三：左侧栏与会话行（上游 `ui-sidebar/` 和 `ui-workspace/`）

- `sidebar/SidebarRoot.module.css`（429 行）、`sidebar/Rows.module.css`（368 行）、
  `sidebar/WorkspaceBrowser.module.css`（505 行）——**三份全部逐字，一个字符没改**。
  折叠态是 **56px 图标轨，不是宽度 0**；会话行高 32、分组头 34。
- `relative-time.ts`——**逐字**（第一轮的「没搬什么」里点过名，这次要了）。
  `frontend/tests/relative-time.test.ts` 8 个用例钉住五档边界和跨年。
- `sidebar/SidebarRoot.tsx` / `Rows.tsx` / `WorkspaceBrowser.tsx`——结构照搬，插槽换 props。

**preflight 这次没撞上**，而且原因值得记下来：上游把每个 inline svg 都装在
flex/inline-flex 容器里，`svg { display: block }` 被 flex item 的 blockify 吃掉了。
所以这批不需要 `user-text.module.css` 那种补丁。**这不是运气**——上游那套 CSS 本来就
不依赖 svg 的 display，是一种更稳的写法。

**一处接口上的取舍**：上游一行只有**一个**前导的 16px 槽，而我们想往里塞两样东西
（CLI 图标、`coverage.hasGap` 的橙点）。选了状态点：真实数据里 11/17 是同一个 CLI，
图标的区分度本来就低（这句话在我们自己的旧注释里就写着），而上游那一行之所以干净，
正是因为只有一个前导标记。CLI 名字那段文字一并丢掉——图标已经说了同一件事。

### 第四轮之二：中栏那三层头收成一个

上游那一栏**只有一个** 76px 的头（这个数等于右栏标签条 38 + 窗格头 38，两条规则在栏边
接得上）。我们原来叠着三层：终端面板头、`ConversationLens` 的历史下拉 + 横幅、
对话自己的头。现在按上游的五个位重新编排，`ConversationRoot.module.css` 里那一批
`.crumbs` / `.headerActions` / `.headerUtilities` / `.headerCorner` / `.tabs`
从空转变成接上了。

**「本终端的历史」那个下拉查过之后确认不能去掉**，收成了动作位里一颗菜单钮：左栏的
搜索覆盖不了它——`terminalId` 在后端是 `EXISTS(ai_generations …) OR EXISTS(conversation_runs …)`
的关联查询，而左栏发的 `q` 只 `instr` 标题和正文；而且左栏默认只列 `active`，
下拉发的是 `state: 'all'`，归档的对话左栏根本看不到。

**告警横幅移到输入座位上方，没有塞进头里。** 头有 76px 的高度契约，塞一个两行的告警
进去就是把契约作废；而 `.composerSeat` 是滚动容器**内部**的 sticky，永远贴栏底、
滚到哪儿都在，比原来跟着头走更难错过。缺口那条保留告警配色——它是坏消息，
降成 `.notice` 那种中性灰等于降一级。

### 第四轮：输入卡与消息体（把我们自己写的那两块换掉）

前几轮是「在我们的外壳上接他们的零件」，这一轮起是**不再保留我们自己那套 UI**。

- `skeleton/InputBar.tsx`——改自上游同名文件，渲染结构一行不动。我们的
  `ConversationComposer` 的**全部标记退场**，只留 `outgoing.ts` 那条发送路。
  **一处被迫的元素级改动**：草稿面从 contenteditable 换成 `<textarea>`。上游那层整棵
  建立在 Lexical 上（芯片是 decorator portal、键位注册到 editor command layer），
  Lexical 没搬、芯片和 `@`/斜杠也都没数据，剩下的需求就只是「会自己长高的多行框」。
  三层包装的类名和 `data-*` 原样保留；连带 `.input p { margin: 0 }` 和
  `.input p:last-child::after`（幽灵提示）在我们这儿永远命中不了，CSS 逐字留着。
- `chat/MessageItem.tsx` 接上了（第二轮搬进来、一直没接）。我们自己写的 `TextBlock`
  退场。真正换来的：气泡底色走 `--dsw-specific-bubble`、宽度跟内容轴联动
  （`min(轴 × 0.702, 82%)`，换掉写死的 `max-w-[85%]`）、以及 `@文件` 引用芯片。

**`textarea` 上三条内联样式是 preflight 逼出来的第三例**（前两例见上面第 3 条）：
`resize: none`——Tailwind preflight 有 `textarea { resize: vertical }`，不压就是胶囊右下角
一个能把它拽变形的把手。同样是 typecheck 和单测看不见、只有画出来才发现的一类。

**一个只有量过才知道的几何陷阱**：消息行的容器必须是 `items-stretch`，右对齐交给
`.userRow` 自己的 `align-items: flex-end`。改成 `items-end` 的话 `.userRow` 会被压成
fit-content，气泡 `max-width` 里那个 `82%` 就按自己的宽度又算了一遍——实测短消息的气泡
从 285px 掉到 234px，白白多折一行。

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
- **输入卡上喂不满的控件**：左下角那颗 `+` 圆钮（查清楚了它在上游**不是附件**，是
  `aria-haspopup="listbox"` 绑斜杠/`@` 命令菜单的，两样我们都没有）、附件轨、
  模式芯片、模型选择、**停止钮**（`shared/api/conversations` 里没有中断某一轮的接口——
  `cancelDelivery` 取消的是还没写进 CLI 的投递，不是已开跑的那轮）、`ContextMeter`。
  prop 全留着。
- **`MessageItem` 的另外四个视图**：`ModelRetryRow`（5 个必填字段全要编）、
  `TurnErrorRow`、`UnknownSurfaceRow`，以及**尤其是 `TurnMaxTokensRow`——它不吃数据、
  只吃文案，接上就是每条消息底下都能冒出一句「输出被截断」**，是言之凿凿的空壳。
  `MessageBody` 里根本没留传 `error` 的口子。
- **侧栏里喂不满的那些**：`sessionStatuses()` 的五档判定（待审批 / 计划待看 / 待回答 /
  running / 子代理数 / completed——我们一条都没有）、行内 `…` 菜单的三个动作（重命名 /
  分叉 / 归档，我们一个都没有）、`SearchResultItem`（要 `snippet`，`listConversations`
  不返回）、HoverCard 悬停卡、拖拽重排、`blank` 占位会话、定时任务闹钟、工作区管理那一套。
  **组件侧的 prop 都留着**（`state` / `stateLabel` / `menu` / `menuOpen`），将来有了直接传；
  对应的 CSS 也一律留在那三份 `.module.css` 里没删——删了，重新同步上游就从「覆盖」
  变成三方合并。
- **`ui-layout` 里没搬的那几个**：`DocumentTitle.tsx`（订阅上游 session/panel 投影拼
  `document.title`，两个投影我们都没有，而浏览器标题是 roost 自己的事）；`service.ts` 的
  `LayoutController`（那是给别的插件用的跨插件面，我们没有插件运行时）；`theme-presenter.ts`
  （把 `ThemeSnapshot` 投到 `body[data-ds-dark-theme]` 上，而我们整张 `tokens.css` 建立在
  `html[data-theme]` 上，搬进来是两套主题机制打架）；上游 `index.ts` 的插件注册；
  `stores.ts` 里 `panelInfo` / `selectPanel` 那一半（那是路由，不是布局）。
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
