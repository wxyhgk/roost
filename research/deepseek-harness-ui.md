# DeepSeek Harness：工具调用渲染与上下文管理

研究日期：2026-09-15。源码位于 `third-party/deepseek-harness/`，上游 https://github.com/deepseek-ai/deepseek-harness 。
本次检出分支 `master`，提交 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`（Merge PR #4192），根 `LICENSE` 为
MIT（`Copyright (c) 2026 DeepSeek`）。

本轮只读源码：**没有安装依赖、没有跑他们的任何测试、没有起过 dsh**。所有数字由本机重新统计。
和[上一轮 happier 的 GUI 渲染器笔记](happier-gui-renderers.md)问的是同一个问题——「一次工具调用怎么画出来」
——所以下文凡是有对照价值的地方都会同时提 happier。

## 结论先行

1. **他们的分派是「线上工具名 → 渲染器」的精确匹配，一个字符的归一化都没有**
   （`tool-call-model.ts:92-94`、`scoped-slots.tsx:807`）。这不是他们偷懒，是因为 dsh 从头到尾
   自己定义工具：`bash` / `read` / `grep` 就是那个名字，连 MCP 都由 host 铸成
   `mcp__<server>__<raw>`（`mcp-client/src/tools.ts:81-87`）。**我们读七家 CLI 的 transcript，
   这条前提不成立**——`identify.ts` 那张别名表在他们那儿没有对应物，也不需要有。
2. **最值钱的一件东西是 `presentationMeta`**（`core/tools/src/index.ts:205-212`）：工具在 host 侧同时
   产出两份东西——给模型看的文本 `render()`，和给 UI 看的结构化 `presentationMeta()`，后者随
   `tool/result` 事件持久化成 `meta`。前端所有的 diff / read / search / web 卡片全部只读 `meta`，
   **不解析给模型看的那段文本**。这正面回答了我们 `BashTool.tsx:18` 记着的那个缺口。
3. **异常处理在他们这儿是「一个纯函数 + 一个共享外壳」**：`toolRowModel()` 把 running / ok / error /
   stopped 四态和错误摘要一次算完（`tool-call-model.ts:237-269`），`ToolRow` 是所有渲染器共用的
   外壳组件。happier 是「外壳独占异常判定、渲染器只画成功路径」；dsh 更进一步——**外壳是个组件，
   渲染器把算好的模型灌进去**，异常路径根本不在渲染器里出现。
4. **长输出一律「掐中间」，不截头也不截尾**（`head-tail-cap.ts:23-26`）：留前 `ceil(n/2)` 行、
   后 `n-ceil(n/2)` 行，中间折叠成一个「还有 N 行」的按钮。我们 `text.ts` 只做尾部截断并在注释里
   说明方向是跟数据语义走的——两种做法不冲突，但**头尾都留**在 diff / 搜索结果上明显更对。
5. **上下文管理（compaction / spill）对我们这种架构基本不成立**，理由见第三节：它们是
   「我自己管对话、我决定发给模型什么」的产物。我们读的是 CLI 自己写的 transcript，压缩与溢出
   是 CLI 已经做完的事，我们只能**认出**它的痕迹，不能自己做。但有一件东西可以直接抄：
   `CompactionSummaryNode`（`records.ts:182-197`）——**压缩标记与被压缩的历史并存**，
   标记只说「模型从这里开始看不到上面了」，不替换任何东西。

## 一、盘子有多大（已从源码确认）

| | 数字 | 统计方式 |
|---|---|---|
| `packages/client/ui-*` 插件包 | **45** | `ls -d packages/client/ui-*` |
| `ui-tool/src` 产品文件 | **31 个 / 3013 行** | `.ts` + `.tsx` |
| `ui-tool/src` CSS Module | 4 个 / 688 行 | `.css` |
| `ui-tool/tests` | 18 个 / 4534 行 | 测试比产品代码多 50% |
| 全仓注册的 keyed 工具视图 | **17 个** | 见下表 |

任务描述里说的「约 50 个 `ui-*` 包」核对结果是 **45**，方向对。

栈是 React 18 + Vite + CSS Modules + `clsx`，**没有 Tailwind**；组件层用的是他们自己的
`@deepseek-ai/dsh-client-ui-primitives`。和 happier 的 React Native 不同，dsh 的组件代码
理论上能读懂就能改写，但整个插件体系压在 Cordis 的 `ctx.slots` 上（另一路 agent 在看那一层），
**脱离 slot 机制单独抄一个组件是没有意义的**——它的 props 有四份来源（owner / 框架标准件 /
registrant 注入 / locale seat），`ui-slots/src/index.ts:103-130` 有说明。

## 二、他们怎么画工具调用

### 1. 两级 keyed 注册表，都在 slot 系统里

第一级：`conversation.chat.node`，按「节点种类」分派（`ui-chat/src/client/contract/slots.ts:186-193`）。
`ui-tool` 用 `key: 'tool-call'` 占住其中一格（`ui-tool/src/client/apply.ts:33-41`）。

第二级：`tool.call.toolview`，**按线上工具名分派**，由 `ui-tool` 声明（`apply.ts:38`），
契约写在 `ui-tool/src/client/contract/slots.ts:26`：

```ts
'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
```

同一个文件 `:12-25` 的注释把设计意图讲得很直白，值得逐字读：

> the key domain is **open** (any wire tool name …), so there is no compile-time key set to pick
> from and **a typo simply never renders**. … A key the shipped composition already covers is
> **replaced, not shared**; an unclaimed key falls back to the generic tool row.

三件事一次说清：键域是开放的（不是 happier 那种 `Record<KnownCanonicalToolNameV2, …>` 穷举类型）、
拼错不会报错只会不生效、认领一个键就是**整个接管**这个工具。

分派点在 `ToolCallTree.tsx:46-49`：

```tsx
: renderSlot('tool.call.toolview', owner, {
    entryKey: toolName,
    fallback: <GenericToolCard {...owner} t={t} />,
  })
```

`fallback` 是**调用方显式传进去的**，不是注册表里的一条万能条目——这正是 happier 踩了坑的地方
（`UnknownToolView` 塞进注册表让外壳的 `if (renderer)` 全变恒真，见上一轮笔记「存疑」第 1 条）。
dsh 这里的形状和我们 `registry.tsx:65` 一样是对的。

slot 系统内部的 keyed 分派实现在 `ui-renderer/src/client/scoped-slots.tsx:806-813`：

```tsx
const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)
if (!entry) {
  const occupied = entries.some(e => e.options.key === opts?.entryKey)
  return occupied ? deadCell() : <>{opts?.fallback ?? null}</>
}
```

`deadCell()`（`:799`）是 `<div data-slot-error={slotKey} />`。它区分了两件我们没区分的事：
**「没人认领这个键」走 fallback，「有人认领过但全都崩了」走崩溃面**——因为 `guarded()`
（`:747-795`）给每个 entry 包了错误边界，而且崩溃时会 `abdicate`（`:754-756`）把这个 entry 退位，
让同一格落到下一个幸存者。

### 2. 匹配靠什么：**工具名，精确匹配，零归一化**

三处都确认了：

- keyed slot：`e.options.key === opts?.entryKey`，字符串全等（`scoped-slots.tsx:807`）
- 变体分类：`TOOL_VARIANTS[toolName] ?? 'others'`（`tool-call-model.ts:92-94`），表在 `:47-74`，
  键是 `bash` / `pwsh` / `read` / `read_image` / `web_fetch` / `web_search` / `grep` / `glob` /
  `write` / `edit` / `run_code` / 四个 `cordis_*`
- 卡片模型：`shellCall()` 里 `if (name !== 'bash' && name !== 'pwsh') return null`
  （`terminal-card-model.ts:185`），`validSearchCall()` 里 `call.name !== 'grep' && call.name !== 'glob'`
  （`search-card-model.ts:29`）

没有 `toLowerCase()`，没有别名表，没有 `mcp__` 前缀拆解——**全仓 `packages/client/` 下
`grep -rn "mcp"` 零命中**（本机实测）。原因在 host 侧：MCP 工具的模型可见名由
`publicToolName()` 铸成 `mcp__<serverName>__<rawName>`，超 64 字符或含非法字符时截断并追加
12 位 SHA-256（`mcp-client/src/tools.ts:81-87`）。那个文件顶上的注释写着
「the public name is **never parsed** to recover it」——**他们刻意规定公开名不可反解**。
于是 MCP 工具在前端必然落到 `others` 变体，摘要变成 `mcp__srv__tool · <第一个字符串参数>`
（`tool-call-model.ts:250-252`）。

> **对我们**：我们**已经有** `identify.ts` 的别名表和 MCP 前缀拆解，而且这是我们必须有、
> 他们不需要有的东西——差别不在实现水平，在数据来源。他们的工具名是自己铸的，我们的是
> 七家 CLI 各写各的。**他们的做法不适用于我们**，反过来我们那张表在他们那儿也是多余的。
> 唯一可借的是那条负面经验：`publicToolName` 会在超长时做有损归一化并加哈希——
> 如果哪天有 CLI 学这一手，我们的 `identifyTool` 拆出来的 server 名就会带着哈希尾巴。目前没遇到。

### 3. 每一类工具画成什么样

全仓 17 个 keyed 注册（本机 grep `'tool.call.toolview'` 去掉 tests 后逐条核对）：

| 键 | 渲染器 | 所在包 | 行 |
|---|---|---|---|
| `bash` | `BashRow` | ui-tool | `toolviews/bash-sample.tsx:161` |
| `read` | `ReadRow` | ui-tool | `toolviews/read-row.tsx:28` |
| `read_image` | `ReadImageRow` | ui-tool | `toolviews/read-image-row.tsx:53-59` |
| `edit` / `write` | `FileMutationRow` | ui-tool | `toolviews/file-mutation-row.tsx:43-44` |
| `grep` / `glob` | `SearchRow` | ui-tool | `toolviews/search-row.tsx:48-49` |
| `web_search` / `web_fetch` | `WebRow` | ui-tool | `toolviews/web-row.tsx:47-48` |
| `todo_write` | `TodoRow` | ui-tool | `toolviews/todo-row.tsx:76` |
| `ask_user_question` | `AskQuestionRow` | ui-tool | `toolviews/ask-question-row.tsx:203-205` |
| `skill` | `SkillRow` | ui-skill | `ui-skill/src/client/index.ts:72-75` |
| `present` | `PresentRow` | ui-deliverables | `ui-deliverables/src/client/index.ts:61-62` |
| `cordis_define` | `CordisDefineRow` | ui-cordis | `ui-cordis/src/client/index.ts:118-123` |
| `cordis_run` | `CordisRunRow` | ui-cordis | `ui-cordis/src/client/index.ts:125-137` |
| `cordis_stop` / `cordis_undefine` | `CordisActionRow` | ui-cordis | `ui-cordis/src/client/index.ts:140-145` |

注意后四条在 `packages/extensions/` 下——**业务包自己注册自己工具的视图**，`ui-tool` 只提供
树、外壳和兜底。`ui-tool/README.md` 里那句是设计原则：
「Business UI packages register only their wire Tool names and atomic views — they do not pair
Session events, rebuild the transcript, or own root/subcall topology」。

**命令执行（bash / pwsh / terminal_send）**：`TerminalBlock` 卡片，带提示符行、cwd、
退出码/信号徽标。退出状态是从**结果文本的尾巴**上用正则剥下来的
（`terminal-card-model.ts:265-271`）：

```ts
const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
const exit = /\n\[exit code: (\d+)\]$/.exec(text)
```

上面那段注释写得很老实——「Parse the marker literals owned by `@deepseek-ai/dsh-shell/render`
without importing that Host-only package into the Client dependency graph」：**这是一处刻意
接受的重复**，为的是不把 host 包拖进浏览器依赖图。没有标记时默认 `exitCode: 0`（`:270`）。

关键的一条：命令失败（退出码非零）**不是** `isError`。`terminalFailed()` 的注释说明了
（`terminal-card-model.ts:85-93`）：「The bash tool settles a failing command as a completed call
(`isError` stays false: the exit status is result data)」，所以行状态要单独提升一次：

```tsx
const state = model.state === 'ok' && terminalModel !== null && terminalFailed(terminalModel)
  ? 'error' : model.state           // bash-sample.tsx:52-54，GenericToolCard.tsx:43-45 同款
```

这和 happier `withCommonErrorMessage` 里「`exit_code ≠ 0` 即失败」是同一条规则，但 dsh 把它
放在**渲染侧**、happier 放在**生产侧**。happier 那个位置更好：一处判完，所有消费者一致。
dsh 的代价是同一段判定在 `bash-sample.tsx:52` 和 `GenericToolCard.tsx:43` 抄了两遍。

**文件读写 / diff**：`write` / `edit` 走 `DiffBlock`。数据来源分两段——
运行中用**参数**推出「打算怎么改」（`diff-card-model.ts:44-81`，`intendedDiff`），
落定后用**结果 meta** 的 `diffs` 数组（`:83-89`，`appliedDiffs`），`write` 的 meta 为空数组时
退回参数推出来的整文件 diff（`:108-110`）。折叠行直接带 `+N -M`（`ToolRow.tsx:170-175`）。
`read` 走 `ReadBlock`，行号来自 meta 的 `lines[]`，而且**要求结果文本匹配一个固定信封**
才认领（`read-card-model.ts:111`）：

```ts
/^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u
```

**搜索**：`grep` 出 `{kind:'matches', files:[{path, matches:[{lineNumber,line}]}]}`，
`glob` 出 `{kind:'paths', paths:[]}`，全部从 meta 读（`search-card-model.ts:82-99`）。
被上游截断时 meta 带 `truncated: true`，而「怎么把完整结果找回来」的定位串**只存在于结果文本里**，
所以卡片下面额外挂一行原文（`ToolRow.tsx:283-287` 的注释说明了理由）。

**待办**：`todo_write` 的摘要是 `planSummary()`（`plan-summary.ts:50-59`）算出来的
「done/total · 第一个 in_progress 的内容」，外加一个**不参与省略号截断**的
`+N` 并行计数（`todo-row.tsx:41-44`，`ToolRow.tsx:232-234`）。`plan-summary.ts:20-26`
的注释解释了为什么要拆成两半：「a count concatenated onto the end of the task name is the
first thing a narrow row clips — exactly when it carries information」。

**子 agent**：**没有工具渲染器**。`subagent` / `subagent_*` 这些名字没有任何 keyed 注册
（`ui-chat/src/client/contract/turn-process.ts:60` 只用它来记数），所以子 agent 调用本身画成
通用行。真正的子 agent UI 是**另一个会话**：`ui-subagent` 往
`conversation.session.header.lineage` 注册一个血缘条（`ui-subagent/src/client/index.ts:65-72`），
点进去打开子会话（`sessions.openSubagent`），子会话的输入框被只读接管
（`SubagentReadOnlyComposer`，`:73-81`）。这和 happier 的 `SubAgentView`（内联展开子 agent 的
轨迹）是两种完全不同的取向。

**MCP**：如前所述，**没有任何专门处理**。落到 `GenericToolCard` 的 `others` 变体。

**认不出来的工具**：`GenericToolCard`（`toolviews/GenericToolCard.tsx`）。它不是一个「兜底
的简陋版」，而是**功能最全的那一个**——它同时尝试 terminal / read / diff / search / web
五种卡片模型（`:36-40`），哪个认领就画哪个。

但要说清楚：**这仍然不是按数据认领**。五个卡片模型每一个内部第一件事都是核对工具名——
`shellCall()` 查 `bash`/`pwsh`（`terminal-card-model.ts:185`）、`validSearchCall()` 查
`grep`/`glob`（`search-card-model.ts:29`）、`intendedDiff()` 查
`write`/`edit`/`str_replace_editor`（`diff-card-model.ts:47`、`:70`、`:76`）。
名字检查只是从注册表挪进了卡片模型。**dsh 从头到尾都是按名字。**
真正「不看名字只看数据」的只有我们一处：`registry.tsx:43` 的
`!!block.patch?.hunks.length`。

变体决定图标（`GenericToolCard.tsx:16-24`）和标题 locale 键（`tool-call-model.ts:32-36`）；
`others` 变体的标题是静态的「工具调用」，**真实工具名被塞进摘要位**：

```ts
const summary = variant === 'others' && toolName !== '' && toolTitleKey === undefined
  ? `${toolName} · ${base}` : base          // tool-call-model.ts:250-252
```

> **对我们**：
> - 命令执行——**我们已经有** `BashTool`，但结构化程度差一截（见第 6 小节）。
> - diff——**我们已经有** `PatchTool`，而且是按数据认领的，比他们按名字更稳。
>   他们比我们多的是「运行中就用参数画出打算怎么改」这一手（`diff-card-model.ts:104`），
>   我们的 patch 只有落定后才有。
> - 搜索 / 待办——**我们缺**，而且缺的原因和上一轮记的一样是数据不是人手。
>   他们的 `{files:[{path,matches:[{lineNumber,line}]}]}` 形状可以直接当目标。
> - 子 agent——**不适用**。他们的子 agent 是独立会话（有自己的 sessionId、自己的输入框），
>   我们的子 agent 调用就是 transcript 里的一个工具块，没有可跳转的对象。
> - MCP——**我们已经有**，而且比他们做得多（`McpTool` + `toolLabel` 拆名）。他们是真的没做。
> - 认不出来的工具——**我们已经有** `SummaryRow`，位置和形状都对。可以借的一点是
>   「兜底也去试各种结构化卡片」，我们目前只有 patch 一种。

### 4. 详情级别与折叠：只有两档，但有第二块屏

**没有 happier 那种 `title / compact / summary / full` 四档。** `ui-tool/README.md` 明确写着
「Every card is read in place in the call tree; there is **no second, full-height presentation**
of a selected call」。每一行就是一个 `useState(false)` 的展开开关（`ToolRow.tsx:137`），
默认全部折叠。

能不能展开由内容决定（`ToolRow.tsx:157`）：

```ts
const expandable = inputRaw !== null || outputText !== null || card !== null
```

折叠时那一行是「图标 · 标题 · 分隔点 · 摘要 · 后缀」；展开后是**卡片优先**——
`askQuestion ?? terminal ?? diff ?? read ?? image ?? search ?? web`（`:156`），
六种卡片互斥，有卡片就不画 IN/OUT 文本段。没有卡片才退回 IN/OUT 两段
（`:299-319`）。单文件工具（read/write/edit）**永远不显示参数段**，理由写在
`GenericToolCard.tsx:56-57`：路径链接就是唯一的参数交互。

第二块屏是 **trajectory 视图**：每个展开的行右下角有个悬停才出现的 Inspect 药丸
（`ToolRow.tsx:322-331`），点了走 `openView('trajectory', callId)`（`ChatView.tsx:245-247`）。
trajectory 是同一批 session 事件的**另一套投影**（`ui-trajectory/src/client/trajectory-tool-definition.ts`，
和 `ui-chat/.../conversation-nodes/tool.ts` 是两份独立的状态机，`tool.ts:9-11` 的注释说这是
有意的），呈现为表格/时间线，看的是原始记录。

**长输出**：三条路，都不丢数据。

1. **卡片内**：head/tail 掐中间。`head-tail-cap.ts:23-26` 一个纯函数，三处共用：

   ```ts
   const hidden = total - maxLines
   const headLines = Math.ceil(maxLines / 2)
   return { hidden, capped: hidden > 0 && !expanded, headLines, tailLines: maxLines - headLines }
   ```

   中间塞一个「展开剩下 N 行」的按钮（`TerminalBlock.tsx:237-247`）。上限分两档：
   primitive 自己的默认是 16（`TerminalBlock.tsx:11`、`ReadBlock.tsx:19`、`SearchBlock.tsx:12`、
   `DiffBlock.tsx:9`），聊天行里收紧成 8 / 8 / 9（`read-card-model.ts:17`、
   `search-card-model.ts:12`、`diff-card-model.ts:7`）。`read-card-model.ts:7-16` 的注释说明
   为什么聊天里减半：「A chat row is a summary surface inside the message flow: the flow must
   stay scannable across many calls」。**bash 行是例外，`maxLines={Infinity}`**
   （`bash-sample.tsx:117`、`ToolRow.tsx:245`）——终端输出不掐。
2. **IN/OUT 文本段**：不截断，**靠 CSS 限高各自滚动**。`ToolRow.module.css:224-232`：
   `max-height: 150px; overflow-y: auto`，注释是「capped and scrolling independently so a long
   input never buries a short output (and vice versa)」。label 是 `position: sticky`（`:253-256`），
   滚的时候标签留在原地。**它不自动滚到底**——和我们 `BashTool.tsx:29` 强制 `scrollTop =
   scrollHeight` 相反。
3. **真·超长**：host 侧的 spill（见第三节）。落到前端时结果文本尾巴上带一段
   「(省略了 N 字节，完整结果存在 <locator>，<取回提示>)」，前端用
   `hasSpillNotice()`（`spill-policy/src/notice.ts:38-51`）认出它，然后**主动降级**：
   终端卡片不认领（`terminal-card-model.ts:308`），改走可展开的通用 IN/OUT。
   `isSpilledShellCall()` 的注释说明了为什么必须降级（`:223-227`）：spill 的尾巴会把退出码标记
   挤走，「a displaced or omitted exit marker cannot establish success」——**读不到退出码就
   不许声称成功**。

> **对我们**：
> - 折叠策略——**我们已经有**（`SummaryRow` 一个 `open`）。他们的两档和我们一样，
>   happier 的四档反而是过度设计（而且两份类型定义还在打架）。
> - **我们缺**「掐中间」。`text.ts` 注释里说的「命令输出留尾部、文件内容留头部」是对的，
>   但那是**只能留一头**时的权衡；`headTailCap` 说明其实可以两头都留。
>   diff 和搜索结果尤其该换——这两种数据的信息在两端都有。
> - **我们缺**「IN / OUT 各自限高滚动」。现在 `SummaryRow.tsx:86` 是结果整块 `max-h-72`，
>   参数段完全不限高——长参数（TodoWrite 的 todos）会把结果顶出屏幕。
>   他们那条注释点的正是这件事。
> - **我们缺**「结果被上游截断」的表达。`BashTool.tsx:7` 的 `MAX_OUTPUT = 4000` 注释说
>   「上游把工具结果截到 4000 字」——但**被截了这件事我们只在自己二次截断时才说**
>   （`clipped`），上游截的那次是静默的。他们的 spill notice 是显式的、可识别的、
>   而且带取回方法。这条不需要抄实现，需要抄的是「截断必须在数据里留下可识别的痕迹」。
> - 第二块屏（trajectory）——**不适用**，至少现在不适用。我们已经有终端本身可以看原始输出。

### 5. 异常处理：一个纯函数定状态，一个组件当外壳

**状态判定只有一处**，`toolRowModel()`（`tool-call-model.ts:237-269`）：

```ts
const done = 'kind' in block
const state: ToolRowState = !done ? 'running'
  : block.error?.code === 'interrupted' ? 'stopped'
    : block.isError ? 'error' : 'ok'
```

四态：`running` / `ok` / `error` / `stopped`。`stopped`（琥珀色）和 `error`（红色）分开，
理由和我们 `parts.ts:20` 把 `denied` 和 `failed` 分开是同一条——**没跑成不是跑失败**。

错误摘要：`errorSummary = state === 'error' && output !== null ? firstLine(output) : null`（`:257`）。
只取首行，多行栈追踪留给展开后的正文——和 happier `resolveToolErrorSummary` 的
`firstLine` 一样。但 dsh 的取值链短得多：happier 是五级候选
（`tool_use_result` → `error` → `error.message` → `message` → `content`），dsh 直接就是
扁平化结果文本的第一行。它敢这么短，是因为结果形状是自己定的。

**失败替换摘要而不是追加**，`ToolRow.tsx:164-166`：

```ts
// A failure must replace, not supplement, the normal summary.
const failureLine = state === 'error' ? errorSummary ?? null : null
const summaryText = failureLine ?? terminalBody?.description ?? summary
```

失败时还会连带丢掉 `summarySuffix`（`:175`）和文件打开链接（`:179`）——
「失败的 read 的路径不该看起来像能点开」。

逐条对照要回答的五种异常：

| 情况 | 他们怎么做 | 出处 |
|---|---|---|
| **失败** | `isError: true` → `state='error'`，红点 `StateDot`、摘要换成结果首行、OUT 段文字变红 | `tool-call-model.ts:243`、`ToolRow.tsx:92`、`:313` |
| **被拒绝** | 审批是**输入框接管**不是行内卡片：`ApprovalPanel` 抢占 `conversation.composer` slot（`ui-approval/src/client/index.ts:80-89`），两个按钮 reject / allowOnce。用户点 reject 之后 host 侧变成一次普通 deny：`{kind:'deny', reason: 'the user rejected tool "x"'}`（`core/tools/src/index.ts:1724-1727`），前端看到的就是一次**普通失败**，没有第四种状态 | 同左 |
| **还在跑** | 没有 `kind` 字段就是 running（`ToolCallBlock = RunningToolCall \| ToolResultNode`，`records.ts:280`）。摘要来自参数，图标保留（`bash-sample.tsx:27-28`「Running keeps the icon — the row sweep carries the in-flight signal」），另有一条视觉隐藏的 `row.running` 文本给读屏器（`ToolRow.tsx:98-109`） | 同左 |
| **结果缺失** | 两种，分得很清。**(a) 回合被打断**：所在 step/turn 已 closed 而调用仍 running 时，**合成**一个结果节点 `{content: [], isError: true, error: {name:'Interrupted', code:'interrupted'}}`，挂在一个合成 seq 上（`ui-chat/.../conversation-nodes/tool.ts:191-205`，判定在 `:214-221`）。**(b) 调用头落在窗口外**：`ToolResultNode.call` 为 `null`（`records.ts:163-164`），`argsRaw` 取不到 → 摘要退化成 `block.callId`（`tool-call-model.ts:244-245`） | 同左 |
| **结果超长被截断** | host 侧 spill，结果文本尾部留 notice；前端 `hasSpillNotice()` 认出后**降级到通用路径**并拒绝推断退出码 | `notice.ts:38-51`、`terminal-card-model.ts:228-236`、`:308` |

还有一种他们单独处理的：**自动审查拒绝**。`AutoReviewDeniedError` / `AUTO_REVIEW_DENIED`
在 `ToolCallTree.tsx:34-45` **抢在 keyed 分派之前**截断——

```tsx
{autoReviewDenied
  ? <GenericToolCard {...owner} t={t} />
  : renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: … })}
```

专用渲染器根本不上场。这和 happier `ToolInlineBody.tsx:244-258` 的「权限终态先截掉」
是同一个形状、同一个位置。**外壳独占终态判定这条设计，两个独立项目各自到达了。**

**渲染器崩了怎么办**：每个 entry 外面有 slot 系统给的错误边界（`scoped-slots.tsx:747-795`），
而且崩溃会 `abdicate`（`:754-756`）——这个 entry 退位，格子落到下一个幸存者；全部退位才显示
崩溃面 `deadCell()`。

> **对我们**：
> - 状态判定集中在一处——**我们缺**。现在 `failed` / `denied` / `result===null` 三个字段散在
>   `SummaryRow` / `BashTool` / `parts.ts` 里各判各的，`toolState()`（`parts.ts:120-121`）只算
>   整条消息的状态不算单次调用。抄一个 `toolRowModel` 形状的纯函数是**性价比最高的一条**。
> - 失败替换摘要——**我们缺**。`SummaryRow.tsx:69-72` 现在是摘要照旧 + 右边追加一个「失败」标签，
>   失败原因要展开才看得到。
> - 四态里的 `stopped`——**我们已经有**对应物（`denied`，`SummaryRow.tsx:72` 用 warning 不用 danger），
>   注释里的理由和他们一字不差。
> - 「还在跑」——**我们已经有**（`result === null`），但没有视觉隐藏的读屏文本。
> - 打断合成结果——**不适用**。那需要「回合有没有关闭」这个概念，而我们读的 transcript
>   里没有 turn/step 的开闭状态。我们的等价问题是「工具调用永远等不到结果」，
>   目前就一直显示 running，没有超时。**这是个真问题但不能照抄他们的解法。**
> - 孤儿结果退化成 callId——**我们已经有**等价行为（`parts.ts:77-79` 给空 name 的孤儿块，
>   `identify.ts:54` 注释说明空名是真实情况）。
> - 渲染器崩溃退位——**我们缺**。`ErrorBoundary` 现在是显示一条错误 + 重试按钮
>   （`shared/ui/ErrorBoundary.tsx:16-19`），**不会退回 `SummaryRow`**。
>   一个渲染器抛异常，那一行就永远是红字而不是「退回改动前的样子」——
>   而 `registry.tsx:16-18` 的注释承诺的正是「认不出来就走兜底，加渲染器永远是加法」。
>   崩溃这条路上那个承诺现在是破的。**这条建议单独开 issue。**

### 6. 参数和结果：文本 vs 结构化，结构从哪来

**参数是纯文本。** `argsRaw: string`（`records.ts:164`、`:270`），前端自己 `JSON.parse`，
失败就退回原样。`parsedToolCall()`（`raw-tool-call.ts:17-39`）做了三件事：
用 `WeakMap` 按 block 缓存、解析失败缓存 `null`、**非对象（数组/标量）也当失败**（`:32-35`）。
这和我们 `toolArgsOf`（`identify.ts:86-99`）几乎一模一样，包括「只有对象才算参数」这条。
他们多一个缓存，我们没有。

`parseArgs` 那句注释值得记（`tool-call-model.ts:150`）：
「Non-JSON args (mid-stream truncation): summary/body fall back to the raw string」——
**流式中途的半截 JSON 是常态不是异常**，和我们老数据解不出是不同原因、同一个应对。

**结果是「文本 + 结构化 meta」两份。** 这是整份笔记里最值得带走的一条。

工具定义里的 output 契约（`core/tools/src/index.ts:205-212`）：

```ts
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode                                   // 校验 canonical value
  render(args: unknown, value: JsonValue): ContentBlock[]           // 给模型看的
  presentationMeta?(args: unknown, value: JsonValue): JsonValue     // 给 UI 看的
}
```

两个都是**纯投影**，都从同一个已校验的 canonical value 推出来。`presentationMeta`
只对顶层调用计算（`index.ts:1815`「computed only for top-level calls」），结果经
`snapshotProjection()` 做无损 JSON 快照（`:529-540`，不无损就抛 `ToolOutputError`），
写进 `ToolExecutionSuccess.meta`（`:561`）。注册时强制检查形状：

```ts
throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
                                                              // index.ts:1049
```

然后 `meta` 随 `tool/result` 事件持久化，前端从事件里直接取（`conversation-nodes/tool.ts:65`
`meta: match.event.data.meta`），**类型是 `unknown`**（`records.ts:170`）。

**前端不信任它。** 每个卡片模型都自己重新收窄一遍：`readMeta()` 逐行校验行号单调递增
且不超过 `totalLines`（`read-card-model.ts:49-72`）、`narrowDiffs()` 校验每个 hunk
（`diff-card-model.ts:28-40`）、`searchFiles()` 三层嵌套逐字段校验（`search-card-model.ts:49-67`）、
`webSources()` 同理（`web-card-model.ts:33-51`）。任何一处不对就返回 `null` 退回通用路径。
`diff-card-model.ts:26` 直接把这叫「defensive narrowing from opaque meta」。

**为什么不用 zod**：全仓 `packages/client/` 下没有 schema 库，都是手写窄化函数。
和 happier「schema 是镜头不是闸门（`passthrough()` + 全 optional + `_raw`）」是相反的取向：
happier 让未知字段原样通过，dsh 让**不认识的形状直接退回兜底**。两者都成立，因为责任不同——
happier 要接七家 provider 的结果，dsh 只接自己的工具。

**还有一套没人用的东西。** `core/tools/src/presentation.ts` 定义了一整套「厂商中立的渲染意图
词汇表」：`ToolCallKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'`（`:15`）、
`ToolCallView = GenericCallView | TerminalCallView | DiffCallView`（`:46`），工具通过
`presentCall(args)` / `presentResult(args, result)` 声明（`index.ts:273`、`:281`），
注释写着「UI bridges map it **without special-casing tool names**」。
约 20 个工具真的声明了它（`tool-fs/src/read.ts:197`、`edit.ts:151`、`write.ts:134`、
`tool-bash`、`tool-web`、`tool-todo`、`tool-skill`、`tool-terminal`、`tool-lsp`、
`tool-cordis`、`tool-ralph` …）。

**但全仓没有一个消费者。** 本机 grep `presentCall|presentResult` 在 `apps/`（cli / web /
desktop / desktop-host）下**零命中**；`packages/` 下的命中全是声明方和类型定义。
`ui-tool/README.md` 还明确说了 web 客户端故意不用它：「Host `presentCall` and `presentResult`
values never enter the Client」——它读的是原始事件字段。

也就是说：**他们设计了一套「工具自我描述、UI 不认工具名」的机制，然后自己的 UI 选择了
按工具名分派。** 那套词汇表是留给外部 bridge（ACP、编辑器插件）的导出契约。

> **对我们**：
> - 参数解析——**我们已经有**，形状和他们一致。可借的只有 `WeakMap` 缓存（`raw-tool-call.ts:10`），
>   在长对话里省的是每次渲染的重复 parse。优先级不高。
> - **结果结构化——这是我们最大的缺口，而 `presentationMeta` 是可抄的形状。**
>   我们的 `MessagePart`（`conversationPayloads.ts:21-28`）只有 `patch` 一个结构化字段，
>   其余全挤在拍平的文本里。`patch` 其实已经就是一个 `presentationMeta`——
>   `EditPatch`（`:14-18`）是解析器在写库时算好的结构，前端只读不算。
>   **把这个模式推广到 bash（stdout/stderr/exit_code）、grep（files/matches）、
>   todo（items）就是下一步。** 上一轮记的「BashResultV2Schema 形状」和这一轮的
>   `presentationMeta` 指向同一件事，从两个独立项目各自确认了一次。
> - 但有一处**不适用**：他们的 `presentationMeta` 是**工具自己**在 host 里算的，
>   我们没有工具、只有 CLI 写出来的 transcript。我们的等价位置是
>   `packages/ai-transcript/src/` 里的各家解析器——**结构化必须在解析器里做，
>   而且每家 CLI 一份**。这比他们贵得多，也更容易漂移。
> - 前端防御性窄化——**我们已经有**一部分（`identify.ts:94` 拒绝数组和标量），
>   但没有到每个字段逐个校验那一步。等有了结构化结果之后这一层是必需的，
>   因为我们的数据来自七个我们不控制的上游。
> - `presentCall` 那套厂商中立词汇表——**不适用于抄，但适用于当反面教材**：
>   一个没有消费者的抽象层，在一个测试比产品代码还多的仓库里活了下来。
>   我们要加「工具种类」这类枚举时，先确认有人读。

## 三、上下文管理

**先给判断：这一整套对我们的架构不成立，而且不是「暂时用不上」，是「位置上就不存在」。**
理由在本节末尾，但先要把它到底解决什么问题说清楚——因为其中有两件**副产品**是成立的。

### 0. 先纠正一个命名误会

`packages/context/` **不是**上下文窗口管理包。它是六个**请求上下文注入插件**
（`packages/context/README.md:12`、`:27-32`）：`agent-instructions`（加载 `AGENTS.md`/`CLAUDE.md`）、
`session-reference`（把另一个会话的快照塞进来）、`file-reference` / `file-reference-local`
（`@file` 提及语法）、`time-context`、`tmux-context`。它们统一挂在 `agent/pre-step` 上，
返回一条 **user 角色的消息**追加进会话日志
（例：`agent-instructions/src/index.ts:315` 挂钩、`:215-224` 造消息）。

所以「注入的上下文」在他们这儿不是旁路数据，**就是普通历史**——
`packages/context/README.md:12` 原话是它「persists, replays, and compacts like other
conversation content」。只有 `agent-instructions` 在出厂配置里，预算 65536 字节
（`packages/bundle/base/cordis.patch.yml:268-271`）。

真正的对话数据模型在 `packages/core/session/`：**一条只增不改的事件日志**，加上一个由它推出来的
「surface」（`core/session/src/surface.ts:1-3`「The append-only log remains the source of truth」）。
surface 只由四种产消息的事件构成（`:50-55`），每个 surface 事件带一个 `surfaceOp`：
`'append'` 或 `{op:'replace', startSeq, endSeq}`（`:294-305`）。**压缩就是往里写一条 `replace`。**

token 计量在第三个地方：`packages/llm/token-meter/`。

### 1. compaction：什么时候触发、压什么、留什么

**三个触发条件，全部是 token 或显式命令，没有一个看消息条数。**

| 触发 | 条件 | 出处 |
|---|---|---|
| 压力（常规） | 每个 step 边界重算，`measurement.totalTokens >= contextWindow × 0.8` | 挂钩 `compaction-basic/src/index.ts:144`，判定 `:301` |
| 上游确认溢出（补救） | provider 回 `CONTEXT_WINDOW_EXCEEDED`，**绕过阈值**，最多重试 1 次 | `index.ts:176-186`、`:280-287`、`config.ts:93` |
| `/compact` 命令 | 用户显式，要求 agent 空闲，**保留量为 0** | `command-compact/src/index.ts:67`、`index.ts:372-380` |

阈值 `thresholdTokens = Math.floor(contextWindow * thresholdRatio)`（`config.ts:144`），
默认比例 **0.8**（`config.ts:20`），出厂 bundle 不覆盖它（`cordis.patch.yml:320-321`），
所以 0.8 是实际生效值。模型没声明 `contextWindow` 时**直接抛错而不是静默压缩**
（`index.ts:293-299`）——这个取向值得记。

**压哪一段**：`selectCompactableRange`（`region.ts:118-156`）。

- **头部保留**：位于 surface 第 0 位的 `system/message` 永远在范围外（`region.ts:132`）。
  这是**唯一的结构性固定项**。
- **尾部保留**：从后往前累加 token，攒够 `retainTokens` 为止（`region.ts:134-141`）。
  默认 `retainRatio = 0.16`（`config.ts:23`），校验强制它小于 `thresholdRatio`（`config.ts:185-190`）。
- **边界不许劈开工具调用/结果对**：切点往前退到配平为止（`region.ts:144-148`），
  两端再校验一遍（`:350-356`）。
- **没有任何对 todo / 文件状态 / 置顶项的特殊保留。** 落在范围里的东西只能靠摘要活下来。

压缩之前先跑一遍**不用模型的**工具结果修剪器：超过 `thresholdChars: 8192` 的 `tool/result`
就地掐成「头 4096 + 标记 + 尾 1024」字符（`compaction-tool-result-pruner/src/config.ts:10-14`），
标记是字面量 `'\n\n[... tool result middle pruned ...]\n\n'`（`config.ts:7`）。
修剪完**重新测一遍**，够不着阈值就不压了（`index.ts:303-309`）。
**「先做免费的，再做花钱的」这条顺序是这套东西里最朴素也最对的一条。**

**压完变成什么**：一次 LLM 调用，用**对话自己的** system prompt 和工具表重放那一段，
末尾追加一条固定的压缩指令（`region.ts:545-564`、`summarizer.ts:119-161`）——
这么做是为了复用 provider 的 KV cache。指令是一个八段式 Markdown 模板
（`summarizer.ts:31-66`：Primary Request and Intent / Key Technical Concepts / Files and Code /
Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context），
`maxTokens` 默认 8192（`config.ts:91`）。**摘要必须真的变小，否则整个事务失败**（`region.ts:418-423`）。

产物是三个持久事件 `compaction/start` / `compaction/summary` / `compaction/end`
（`region.ts:211`、`:492-506`、`:238`），外加一条合成的 `user/message`，
带 `surfaceOp: {op:'replace', startSeq, endSeq}` 和引用了每一个被遮蔽节点 seq 的
`sourceEventSeqs`（`region.ts:507-510`）。内容包在 `<compacted-summary>` 标签里
（`summarizer.ts:186-192`）。

**原文不删。** 日志只增不改，`replace` 只是把节点从 **surface** 上摘掉；
而且 `core/session/src/surface.ts:340-343` **强制**一条 replace 事件必须列全它遮蔽的所有 seq。

**UI 里可看不可逆。** 聊天里是一个 `kind: 'compaction'` 的标记行
（`ui-chat/.../conversation-nodes/compaction.ts:31-57`）。`CompactionItem.tsx:1-2` 开头那句
就是设计声明：

> A compaction marker does not replace shadowed transcript rows.

被遮蔽的那些行**照样留在界面上**，标记只说「模型从这儿开始看不到上面了」，
并显示条目数和 token 数、展开看摘要原文。`records.ts:182-197` 的
`CompactionSummaryNode` 注释也是同一句话。trajectory 那边还能看到摘要器的原始输出和 usage
（`trajectory-compaction-definition.ts:61-76`）。**没有任何反压缩 / 恢复 API**，
要找回只能读原始日志。

### 2. spill：溢到哪、什么时候取回

**「溢出」= 超长的纯文本工具结果被写进一个本地私有文件，对话里只留头尾预览 + 一段告示。**

- 契约小得惊人：`SpillStore` 只有 `saveText(input): Promise<SpillRef>` 一个方法
  （`spill/spill/src/index.ts:45-56`），`:8-12` 明说这是刻意的。
  **没有 read / fetch / list——取回不是这一层的事。**
- `SpillRef = {locator, bytes, retrievalHint}`（`spill/spill/src/types.ts:76-80`）。
- 本地后端写到 `<root>/session-<sha256(sessionId)前12位>/<6位随机hex>-<转义后的名字>`
  （`spill-local/src/store.ts:110`），目录 `0700`、文件 `open(path,'wx',0o600)`（`:113`、`:115`），
  root 默认是懒创建的 `mkdtemp(tmpdir, 'dsh-spill-')`。启动时扫一次，删掉超过
  `cleanupPeriodDays`（默认 30）的（`spill-local/src/index.ts:68`、`:113-117`）。
- **阈值 `maxInlineBytes`，按 UTF-8 字节数**（`spill-policy/src/index.ts:197-198`）。
  代码里**没有内置默认值**——不配就是彻底 no-op（`:107-108`）。
  出厂 bundle 配的是 **50000**（`cordis.patch.yml:389`）。
- 留在对话里的是：`headBytes: ceil(budget/2)` + `tailBytes: floor(budget/2)` 的**头尾预览**
  （`spill-policy/src/index.ts:96-103`），后面跟一段
  `(Omitted <N> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`
  （`notice.ts:5-8`、`:20-21`）。**又是掐中间**——和前端卡片的 `headTailCap` 同一个取向。
- **告示的最坏字节数是先从预算里扣掉的**（`index.ts:158-170`），所以「预览 + 告示」保证不超上限；
  连告示自己都放不下时，**原样保留不溢出**并打 warning（`:171-181`）。
- **取回是模型自己做的**：`retrievalHint` 字面量就是
  `'Use read with offset/limit, or grep this path to search within it.'`
  （`spill-local/src/index.ts:159`）。所以「取回」= 模型下一轮发一个 `read` 或 `grep` 工具调用。
  为了不出现 `read → spill → 再 read` 的死循环，**`read` 工具被显式排除在溢出之外**
  （`spill-policy/src/index.ts:29-32`、`:191-192`）。
- **UI 完全不取回**。前端对整个 spill 体系的唯一依赖是一行 import：
  `terminal-card-model.ts:5` 的 `hasSpillNotice`，用途只有一个——认出来之后**拒绝推断退出码**
  （`:228-236`、`:308`）。
- **只溢工具结果**，挂在 `tools/post-execute`（`:185-204`）和 `tools/ptc-dispatch-log`（`:212-226`）上。
  用户输入和助手输出没有任何溢出路径。而且全程 best-effort：拿不到会话、没有后端、
  `saveText` 失败——三种情况都保留原文（`:133-156`），因为
  「a spill failure must never turn a successful call into `isError`」（`:33-35`）。

顺带：token 计量**没有真 tokenizer**。全仓 grep `tiktoken` / `gpt-tokenizer` 零命中。
用的是固定字符密度 `CHARS_PER_TOKEN = 4` + 每块 4 + 每角色 4 的开销
（`llm/token-meter/src/estimate.ts:13-19`），并以 **provider 上报的 usage 作为基线锚点**——
只在请求信封对得上、且上报总数 ≥ 启发式锚点时才采信（`token-meter/src/index.ts:158-171`）。
当前压力 = 基线 + surface 增量（`:187`）。

### 3. 判断：对我们成立吗

**机制不成立，位置上就不存在。**

compaction 的触发点是 `agent/pre-step`——**每一步请求发出之前**
（`core/agent-loop/src/agent.ts:250-251`）。它做的事是「决定这次发给模型的消息数组长什么样」。
spill 的触发点是 `tools/post-execute`——**工具结果进入上下文之前**。
**这两个位置我们一个都没有**：我们不跑 agent loop，不组装请求，不执行工具。
我们读的是 CLI 自己写完的 transcript 文件——到我们手上时，
上下文早已被 CLI 自己的压缩和截断处理过了。

说得更死一点：**在我们这个架构里，"压缩上下文"这个动作的执行者是 Claude Code / codex / 等等本身。**
我们能做的只有「认出它做过」。自己再压一遍既没有作用点（我们不发请求），
也会破坏我们唯一的职责（如实显示 CLI 干了什么）。

所以：

- **compaction 引擎、阈值、摘要器、`replace` 事件**——不适用，不要抄。
- **spill 存储、策略插件、`maxInlineBytes`**——不适用，不要抄。
- **token-meter**——不适用于「触发压缩」，但**部分适用于展示**。
  如果以后要做「这个会话吃了多少上下文」（他们有 `ContextMeter`，
  `ui-conversation/src/client/skeleton/ContextMeter.tsx`），他们的做法值得照搬：
  **以 provider 上报的 usage 为锚、增量用启发式估**，而不是自己从头数。
  Claude 的 transcript 里就带 usage。**这是一条可能的未来方向，不是现在的缺口。**

**但有两件副产品是成立的，而且其中一件今天就相关。**

1. **「压缩标记不替换历史」这条呈现规则可以直接用。**
   `CompactionItem.tsx:1-2` + `records.ts:182-197`：被遮蔽的行照样显示，
   标记只是一条可展开的、带条目数和 token 数的分隔行。
   **我们的 transcript 里 CLI 自己的压缩也会留下痕迹**——Claude Code 的 `/compact`
   会在 transcript 里写一条摘要消息。我们现在**极可能是把它当普通助手消息画的**。
   这一条没有在本轮核实（我没读我们的解析器），**列为下一轮第一件要查的事**。
2. **「截断必须在数据里留下可识别的痕迹，而且消费方只认不取」这条今天就相关。**
   `hasSpillNotice`（`notice.ts:38-51`）是个纯函数，只回答「这段文本末尾是不是一段告示」，
   认出来之后前端做的唯一动作是**降级**：不画终端卡片、不推断退出码。
   `terminal-card-model.ts:223-227` 的理由写得很好——
   「a displaced or omitted exit marker cannot establish success」。
   对照我们：`BashTool.tsx:7` 注释说「上游把工具结果截到 4000 字」，
   **但被上游截了这件事在我们的数据里没有任何痕迹**，我们只在自己二次截断时才说 `clipped`。
   结果是：一个被上游截断的 `npm test` 输出，看起来和一个正常结束的一模一样。
   **要补的不是 spill，是「上游截断标记」这个字段，以及一个只认不取的识别函数。**

## 四、存疑与未验证

1. **完全没有跑过他们的任何东西。** 没装依赖、没跑测试、没起 dsh。所有行为结论都是读代码
   读出来的，没有一条有本机复现。`ui-tool/tests/` 下 18 个文件 4534 行测试**一行都没读**，
   里面大概率有本笔记推断错的地方的反例。
2. **`str_replace_editor` 的落定路径**：`diff-card-model.ts:105` 注释说它「settles through
   Generic because it has no result view」，但它既不在 `TOOL_VARIANTS` 里也没有 keyed 注册，
   所以它的运行中 diff 能画、落定后既没有 diff 也没有专用标题。看起来是有意的，没有确认。
3. **`chain` 类型的 slot 存在**（`ui-slots/src/index.ts:98`，选择器路由，
   `scoped-slots.tsx:814-838`），`conversation.chat.turnTail` 用了它
   （`ui-chat/.../contract/slots.ts:211`）。**工具视图用的是 `keyed` 不是 `chain`**——
   这是一个明确的选择，但仓库里没有找到解释这个选择的注释。
4. **两处重复的退出码状态提升**（`bash-sample.tsx:52-54` 和 `GenericToolCard.tsx:43-45`
   逐字相同，连注释都一样）。看起来是复制粘贴而不是设计，但 `.jscpd.json` 存在说明他们有
   重复检测——可能被豁免了，没查。
5. **`bash-sample.tsx` 的文件名和注册名都叫 "sample"**（`name: 'bash-toolview-sample'`，`:157`），
   注释写「Registers the standalone Bash conversation-row sample」。它是唯一一个**不复用
   `ToolRow` 外壳、自己画一遍行**的渲染器（自己的 `leadingFor`、`stateStatus`、
   展开逻辑、IN/OUT 段，`:23-152`）。是示范代码还是有意的特例，没有确认——
   但它的存在意味着**外壳并不是强制的**，这削弱了「共享外壳」那条设计的强度。

上下文管理那一节另有五条没核实的（该节的调研是并行做的，以下是它自己标注的未确认项，
我复核了其中的字面常量——0.8 / 0.16 / 50000 / 8192·4096·1024 / `CHARS_PER_TOKEN=4`
全部本机对上了，其余照录）：

6. **UI 是否真的从不读取 spill 出去的文件内容**。依据是 `packages/` 下对 `dsh-spill*` 的
   import 全量 grep（客户端只有 `terminal-card-model.ts:5` 一处，且只用 `hasSpillNotice`），
   不是逐文件通读 `packages/client/**`。
7. **助手输出是否可能被溢出**。没找到任何路径，但同样是 grep 得出的否定结论。
8. **`@deepseek-ai/dsh-output-retention` 包没有打开**（`describeOmitted` / `TextRetainer`），
   所以告示里省略子句的确切措辞和 head/tail 边界行为只到调用点为止。
9. **`thresholdRatio` / `retainRatio` / `maxInlineBytes` 在 `packages/bundle/base/` 之外的
   profile 覆盖没有全查**（`apps/`、`preset/` 下没审）。
10. **`docs/subsystems/compaction.md` 和 `docs/subsystems/spill.md` 没有通读**——
    那里若写了代码里没有的契约，本笔记不会知道。

## 五、对我们的结论

### 已经确认我们做对的三处

1. **兜底由外壳显式选择**（`registry.tsx:65`）。dsh 的 `ToolCallTree.tsx:48` 是同一个形状，
   happier 是反面教材。两个独立项目各自到达，这条可以当定论了。
2. **拒绝不是失败**（`SummaryRow.tsx:71-72` 的 warning vs danger）。dsh 的
   `stopped` / `error` 分开（`tool-call-model.ts:241-243`）是同一条，理由注释几乎一样。
3. **patch 按数据认领不按名字**（`registry.tsx:43`）。本轮确认这一点**我们是三家里唯一做到的**：
   happier 全按名字，dsh 名字检查只是挪进了卡片模型（见第四节第 2 条更正过的那段）。

### 建议做的，按性价比排序

1. **抽一个 `toolRowModel` 形状的纯函数**，把「这次调用是什么状态、摘要是哪一行、
   失败摘要是什么」一次算完（对标 `tool-call-model.ts:237-269`）。
   现在这三件事散在 `SummaryRow` / `BashTool` / `parts.ts` 里各判各的。
   这是纯重构、可测（不需要 jsdom）、不改行为，是本轮唯一一条零风险的。
2. **失败时用错误首行替换摘要，而不是在右边追加标签**（对标 `ToolRow.tsx:164-166`）。
   现在失败原因要展开才看得到。连带把文件路径链接这类「看起来能点」的东西在失败时去掉。
3. **`ErrorBoundary` 退位到 `SummaryRow`**。`registry.tsx:16-18` 承诺「认不出来就走兜底，
   加渲染器永远是加法」——但渲染器**崩溃**这条路上这个承诺是破的：现在是一行红字加重试按钮
   （`shared/ui/ErrorBoundary.tsx:16-19`），不是退回改动前的样子。
   dsh 的 `abdicate`（`scoped-slots.tsx:754-756`）做的正是这件事。**这条建议单独开 issue。**
4. **IN / OUT 各自限高滚动**（对标 `ToolRow.module.css:224-232` 那条注释：
   「a long input never buries a short output」）。现在 `SummaryRow.tsx:86` 只限结果、
   参数段完全不限高——长参数会把结果顶出屏幕。label 用 `position: sticky` 一并抄。
5. **diff 和搜索结果改成掐中间**（`head-tail-cap.ts:23-26`）。`text.ts` 的尾部截断留给命令输出，
   它那段注释说的方向没错，只是「只能留一头」这个前提不是必然的。

### 还要先查清楚才能动的

1. **CLI 自己的压缩痕迹我们现在怎么画的？** dsh 的规则是「标记不替换历史、可展开看摘要、
   带被遮蔽条目数」（`CompactionItem.tsx:1-2`、`records.ts:182-197`）。
   Claude Code 的 `/compact` 会在 transcript 里留东西，**我们现在极可能是当普通助手消息画的**。
   本轮没有读我们的解析器，这是下一轮第一件事。
2. **「结果被上游截断」这件事有没有落进我们的数据。** `BashTool.tsx:7` 注释说上游截到 4000 字，
   但被截这件事在 `MessagePart` 里没有字段。对标的不是 spill 本身，是
   `hasSpillNotice`（`notice.ts:38-51`）那种**只认不取、认出来就降级不推断**的消费方式。
   要补的是一个截断标记字段加一个识别函数。

### 明确不做的

- **compaction / spill 引擎**：位置上不存在（见第三节末）。我们不组装请求、不执行工具，
  这两个 hook 点我们一个都没有。
- **子 agent 独立会话**：他们的子 agent 有自己的 sessionId 和输入框
  （`ui-subagent/src/client/index.ts:65-81`），我们的子 agent 调用就是 transcript 里的一个工具块。
- **穷举型注册表**：上一轮就记过，我们没有「规范工具名」的封闭集合。
  这一轮补一条新证据——**dsh 有那个集合却故意不穷举**（`contract/slots.ts:12-25`
  明说键域是开放的、拼错不报错）。理由是要让业务包在自己的包里注册自己的工具。
  我们的理由不同（数据来自七家 CLI），但结论一样：别做。
- **`presentCall` / `presentResult` 那套厂商中立词汇表**：他们自己都没有消费者
  （`apps/` 下零命中）。要加「工具种类」这类枚举时先确认有人读。
