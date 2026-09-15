# DeepSeek Harness：对话消息体（ui-chat / ui-conversation）搬运评估

研究日期：2026-09-15。源码位于 `third-party/deepseek-harness/`，上游 https://github.com/deepseek-ai/deepseek-harness 。
本次检出分支 `master`，提交 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，根 `LICENSE` 为 MIT（`Copyright (c) 2026 DeepSeek`）。

**本轮只读源码，没有装依赖、没有跑他们的测试、没有起过 dsh，也没有改动本仓库一个字节。**
所有行数、体积、字段由本机重新统计；体积用本仓库的 `node_modules` + esbuild 现场测得，测不了的明确标注。

这一轮问的是[上一轮](deepseek-harness-ui.md)没问的那半边：工具调用之外的**消息体本身**——
`packages/client/ui-chat/`（9670 行 ts/tsx + 1808 行 css）和 `ui-conversation/`（10944 + 1766）。
积木层（`ui-primitives`）由另一路 agent 搬到 `frontend/src/vendor/dsh/`，本文只读它、不改它，
但它已经落地的那部分**显著改变了本文的结论**（见第三节末与第五节）。

---

## 结论先行

1. **19614 行里，值得原样搬的是 1219 行。** 三档统计（第一节）：ui-chat 9670 行中
   「纯展示可搬」1219 行 / 「要改写」1970 行 / 「不能搬」6481 行；**ui-conversation 的 10944 行
   里属于「消息体」的是 0 行**——它是会话装配 + 输入法编辑器 + 队列，和我们的
   `ConversationComposer` / `recovery.ts` 是同一格的东西，而且我们那一格已经有人。

2. **他们的数据模型从根上不同，而且差别不在字段多少，在「谁产生结构」。**
   ui-chat 的每一个节点都是 host 的 session **事件流**折出来的状态机产物：
   `turn/start` / `step/start` / `assistant/message` / `tool/call` / `tool/result` /
   `turn/end`（`ui-conversation/.../conversation/location-index.ts:299-343`、`:418-469`）。
   **回合号 `turn` 和步号 `step` 是 host 发的号，不是 UI 算出来的**
   （`contract/conversation.ts:92-97` 的 `TurnLocation` 直接挂着 `turn/start` / `turn/end` 事件本身）。
   我们读的是 CLI 写完的 transcript，这些事件一个都没有。
   → `ui-chat/src/client/conversation-nodes/` 整个目录（20 文件 / 3860 行）**位置上不成立**。

3. **markdown：他们自己写了一整套 mdast → React 的直渲管线**（不经 HTML、不用 remark/rehype），
   带增量流式解析、同步 shiki 高亮、KaTeX（`ui-primitives/src/markdown/`，12 文件 / 3199 行）。
   **换过去在我们这儿是净亏**，量化见第三节：我们是**只读历史**，没有流式，
   `incremental.ts` 那 360 行解决的问题我们根本没有；而代价是实测 **+61.6 KB gzip**
   进对话分块，外加 KaTeX（未测，但 `render.tsx:26` 是**静态** import，不启用也带进来）。
   另一路 agent 已经独立得出同一结论并落地了一个纯文本替身
   （`frontend/src/vendor/dsh/markdown/MarkdownText.tsx:1-18`）。

4. **回合（turn）：他们不画分隔线。** 全仓 ui-chat 的 CSS 里没有任何「回合边界」样式——
   流就是一列等间距的行（`chat/ChatView.module.css:49-51`，唯一的规则是 16px 的间距）。
   回合的表达是**三件别的东西**：左侧 `TurnNavigator` 导轨、回合尾 `turn-tail` 页脚
   （用量 / 耗时 / 分支），以及 **`turn-process` 折叠**——把「用户提问」和「最终回答」之间
   的全部过程收成一行「5 次工具调用 · 2 条消息」。
   **`turn-process` 是这一轮最值钱的一件东西**，因为我们 `buildItems`（`parts.ts:141-199`）
   已经在算回合范围了，只是把结果用来画了一条线。

5. **最小可行搬法是三步，第一步不碰解析器、不碰 `parts.ts` 的现有规则**（第五节）：
   先补 `ReasoningRow`（thinking 现在被拼进正文里，是个真 bug），
   再做 `turn-process` 折叠（复用现成的回合范围），最后才谈 `usage`。

6. **顺带结清一笔旧账（本轮实测）**：上一轮列为「下一轮第一件要查的事」的
   「CLI 自己的压缩痕迹我们现在怎么画的」——查清了，**我们画成了一条用户消息**。
   Claude Code 把 `/compact` 写成一条 `role: "user"`、带 `isCompactSummary: true` 和
   `isVisibleInTranscriptOnly: true` 的记录（本机 62 个 transcript 里命中 3 条，见第二节第 4 小节），
   而 `packages/ai-transcript/src/claude.ts:103-106` 两个字段都不读。
   于是它在界面上是一条几千字的「你」的发言，而且因为 `parts.ts:191` 的
   `isUser && index === 0` 还会**画出一条回合边界**。这是一个 15 行左右能修的真 bug，
   dsh 的 `CompactionItem.tsx:1-2` 正好给了正确的呈现规则。

7. **明确不划算的两块**（第六节给量化理由）：`AssistantMarkdown` 那一棵树、
   以及 `ui-conversation` 整包。前者 8 个新 npm 包换一个我们用不上的流式能力；
   后者 10944 行里 10326 行属于「不能搬」，而剩下的 618 行是**类型定义，只该读不该搬**。

---

## 一、三档清单（已从源码确认）

分档标准写死，免得「可搬」变成一个主观词：

| 档 | 判据 |
|---|---|
| **甲 纯展示可搬** | 只依赖 React + 已 vendor 的 `ui-primitives` + 一个 `t(key, params)` + 自己的 CSS module。换 props 类型和 `t`，**函数体一行不动**。不需要任何新 npm 包 |
| **乙 要改写** | 逻辑值得抄，但形状绑在他们的节点类型（`ChatNode` / `ConversationNode` / `TurnLocation`）或我们没有的引擎上，必须照我们的 `HistoryMessage` 重写 |
| **丙 不能搬** | 依赖 cordis 上下文、slot 运行时、session 事件流、host 投影或输入法编辑器。**不是「难」，是位置上不存在** |

### ui-chat（9670 行 ts/tsx + 1808 行 css）

**甲：16 个文件 / 1219 行 ts/tsx + 767 行 css**

| 文件 | 行 | 它是什么 |
|---|---|---|
| `chat/TurnNavigator.tsx` | 222 | 左侧回合导轨：固定 10px 间距的刻度、悬停预览卡、活动刻度自动居中（`:19-23`、`:111-120`） |
| `chat/TurnUsagePanel.tsx` | 182 | 回合用量 / 回合耗时两个药丸 + 各自的 portal 弹层（`:46-92`、`:49-53` 算缓存命中率） |
| `chat/MessageIconActions.tsx` | 114 | 一条消息尾部的图标行（复制、分支、时钟） |
| `chat/message-chrome.ts` | 103 | 时长 / 时刻 / 吞吐的格式化 |
| `chat/token-format.ts` | 98 | token 数的紧凑与精确两种格式、缓存命中率 |
| `chat/CompactionItem.tsx` | 76 | 压缩标记行（见结论第 6 条） |
| `chat/stat-dialog.ts` | 66 | 统计弹层的定位与外点关闭 |
| `chat/GenericCommandCard.tsx` | 65 | 斜杠命令的通用卡片 |
| `chat/ReasoningRow.tsx` | 64 | **思考折叠行**：收起时显示首行（流式时显示末行）、展开看全文（`:28-31`） |
| `chat/TurnProcessNodeView.tsx` | 60 | **回合过程折叠的控制行**：「N 次工具调用 · M 条消息」（`:38-40`） |
| `chat/searchable-hidden.ts` | 31 | `hidden="until-found"` 的封装：折叠内容仍能被浏览器查找命中并自动展开 |
| `chat/CompactionCommandCard.tsx` | 26 | 手动 `/compact` 的命令卡 |
| `chat/use-calendar-day.ts` | 25 | 跨天时让时间戳重算 |
| `contract/turn-process.ts` | 61 | 回合过程的规格类型 + 「哪些行不参与折叠」集合（`:20-33`）+ 子 agent 名判定（`:59-61`） |
| `client/markdown-labels.ts` | 16 | markdown 的本地化文案适配 |
| `chat/turn-assistant.ts` | 10 | 从 blocks 里取纯文本 |

CSS：`TurnNavigator` 234、`ReasoningRow` 121、`MessageIconActions` 101、`stat-dialog` 94、
`GenericCommandCard` 86、`TurnUsagePanel` 75、`TurnProcessNodeView` 48、`accessibility` 8 = **767 行**。
（`CompactionItem` 借用 `MessageItem.module.css` 里 20 条 `.compaction*` 规则，未计入。）

**这一档的前置条件已经满足**：这 16 个文件用到的 11 个图标
（`IconThinkOutline14` / `IconApiOutline14` / `IconDatabaseOutline16` / `IconClockOutline16` /
`IconBranchOutline16` / `IconCopyOutline16` / `IconCheckOutline16` / `IconChevron{Down,Right}Outline14`
/ `IconContextInjectionOutline16` / `IconBrowseOutline16`）**全部已在
`frontend/src/vendor/dsh/icons/index.tsx` 里**（本机逐个核对，11/11 命中），
`DisclosureRow` 和 `StateDot` 也在。**唯二缺的是 `stat-dialog.ts` 要的
`useAnchoredPosition` / `useDismissOnOutsidePointer`**——我们有 `@floating-ui/react`
（`frontend/package.json`），那 66 行重写比 vendor 更划算。

**乙：14 个文件 / 1970 行 ts/tsx + 694 行 css**

| 文件 | 行 | 为什么要改写 |
|---|---|---|
| `chat/ContextBody.tsx` | 592 | 上下文注入的正文分型（`AGENTS.md`、`@file`、session 引用…），形状是他们的 `KnownContextForm` |
| `chat/MessageItem.tsx` | 387 | 用户气泡 + 重试 / 回合错误 / max-tokens / 未知节点五个视图。用户文本走 `projectUserText`（**不按 markdown 渲染**，和我们 `ConversationDetail.tsx:284-287` 的取向一致），但那个函数没 vendor |
| `chat/AssistantMarkdown.tsx` | 153 | blocks 循环（text / reasoning / image / tool-call / other）本身是好东西，但它的 `text` 分支就是 `MarkdownText`（见第三节） |
| `conversation-nodes/turn-process-presentation.ts` | 139 | 回合过程的投影器 |
| `contract/chat-nodes.ts` | 129 | 全部节点载荷类型 |
| `contract/turn-metrics.ts` | 99 | TTFT / 解码吞吐的折叠（`:72-98`），依赖 `AssistantMessageNode.timing` |
| `conversation-nodes/turn-navigation.ts` | 96 | 导轨条目的预览文本（`:11-12` 预算 50 / 120 字符，`:18-40` 的 `preview()` 有逐段上限） |
| `chat/turn-rail-items.ts` | 89 | 把 host 的 `turnOutline` 投影和本地条目合并 |
| `chat/ContextInjectionRow.tsx` | 71 | 同 ContextBody |
| `chat/TurnTailNodeView.tsx` | 69 | 回合尾页脚 |
| `chat/SystemPromptRow.tsx` | 50 | system prompt 行 |
| `chat/AssistantNodeView.tsx` | 41 | assistant 节点的 seat 包装 |
| `chat/CommandNodeView.tsx` | 40 | 命令节点的 seat 包装 |
| `contract/assistant-content.ts` | 15 | 「这条 assistant 有没有可见回复」 |

**丙：6481 行 ts/tsx + 347 行 css**

- `conversation-nodes/` 20 文件 3860 行（减去上面归到乙的两个后 3625 行）——
  session 事件驱动的节点状态机，**每个 Definition 都是 `match / start / update / publication /
  buildLocationData / buildViewNode` 六件套**（`turn-process.ts:209-301` 是完整的一份）。
  没有事件就没有输入。
- `chat/ChatView.tsx` 881 + `chat/ChatNodeSeat.tsx` 150 + `chat/register-node-renderers.ts` 57：
  slot 运行时 + store 订阅 + 锚点分页。
- `conversation-nodes/chat-snapshot-builder.ts` 1078：可变节点仓库 + 细粒度订阅源。
- `chat/StatsPills.tsx` 359、`settings/TranscriptViewRow.tsx` 79、`transcript-view.ts` 39、
  `apply.ts` 179、`contract/slots.ts` 219、`contract/snapshot.ts` 142、`model/` 287、
  `stores.ts` 47、`locale.ts` 223（我们有自己的 i18n）等。

### ui-conversation（10944 行 ts/tsx + 1766 行 css）

**甲 0 行。乙 618 行，而且这 618 行是「读」不是「搬」**：
`contract/records.ts` 287、`contract/conversation.ts` 297、`contract/snapshot.ts` 34——
它们是字段清单和命名参考，第二节全靠它们。**丙 10326 行 + 全部 1766 行 css。**

按目录：

| 目录 | 文件 / 行 | 是什么 |
|---|---|---|
| `client/input/` | 20 / 3117 | 输入法编辑器（ProseMirror 式的自研 contenteditable、引用 chip、keymap、span 映射） |
| `client/conversation/` | 7 / 2215 | 事件装配器（`assembler.ts` 958、`location-index.ts` 614） |
| `client/contract/` | 13 / 1832 | 契约类型 |
| `client/skeleton/` | 11 / 1667 | 面板骨架 + 输入条 + `ContextMeter` + `TodoPanel` |
| `client/` 根 | 2 / 662 | `service.ts` 603（cordis 服务） |
| `client/queue/` | 1 / 393 | 排队投递 |
| `client/settings/` | 1 / 76 | 回车行为设置 |

**判断：这个包和「消息体」无关。** 它是「会话这一格怎么装配、输入怎么进去」，
对应我们的 `ConversationComposer.tsx` + `useOutgoing.ts` + `recovery.ts` + `outgoing.ts`，
而我们那一套是**贴着 daemon 投递语义**写的（`DeliveryState` 六态、`reason` 说明为什么还没投递，
`conversationPayloads.ts:61-70`），和他们「我自己就是 agent」的前提正好相反。

### CSS 令牌：这是可搬那一档的真实成本

`ui-chat` 的 CSS 引用 **52 个不同的 CSS 变量**，其中 **34 个是 `--dsw-*`**——
定义在 `packages/client/ui-theme/`（8 个 css 文件 / 948 行 / **357 个 `--dsw-*` 令牌**），
不在这两个包里。也就是说搬 CSS 要么映射这 34 个，要么把 ui-theme 也搬。

**这件事已经有人做过一遍了**：`frontend/src/vendor/dsh/tokens.css` 是另一路 agent 写的桥接表，
自述接了 28 个。所以甲档那 767 行 CSS 的令牌成本**已经被摊薄**——但要复核它是否覆盖
`--dsw-alias-state-business-primary`、`--dsw-elevation-panel`、`--dsw-font-xxs-12` 这几个
只在 ui-chat 出现的名字（**本轮未逐个核对，列为存疑**）。

---

## 二、数据模型对照（Q2）

### 1. 他们的三层

**第一层：`ConversationNode`**（`ui-conversation/.../contract/records.ts:251-262`）——
11 个成员的判别联合：`user` / `assistant` / `steering` / `context` / `model-retry` /
`turn-error` / `turn-max-tokens` / `tool-result` / `command` / `compaction` / `unknown`。
每个都带 `seq`（事件序号，**同时是 React key**）和 `time`。

`AssistantMessageNode`（`:61-84`）是最能说明差别的一个：

```ts
kind: 'assistant'; seq; messageId?; time; turn; step
blocks: readonly AssistantBlock[]
usage?: unknown
providerMetadata?: { provider, model }
requestConfig?: { provider, model, thinking?, reasoningEffort?, temperature?, maxTokens? }
timing?: { stepStartTime, firstTokenTime, completedTime }   // 三个都可能是 null
interrupted?: true
```

`AssistantBlock`（`:33-38`）只有五种：`text` / `reasoning` / `image` / `tool-call` / `other`。
**`reasoning` 是一等公民，和 `text` 平级。**

**第二层：`ChatNode`**（`ui-chat/.../contract/chat-nodes.ts:22-27`）——
按 `ChatNodeDataMap`（`:16`，一个可合并扩展的空接口）分派的最终渲染单元。
比第一层多出四种**纯 UI 概念**的节点：`turn-process`（`:101-111`）、`turn-tail`（`:86-98`）、
`manual-compaction`（`:51-54`）、`retry`（`:57-60`）。

**第三层：`TurnLocation` / `StepLocation`**（`ui-conversation/.../contract/conversation.ts:92-97`）——
不是节点，是节点挂靠的坐标：

```ts
interface TurnLocation {
  readonly turn: number
  readonly start?: SessionEvent<'turn/start'>     // location-index.ts:131
  readonly end?: SessionEvent<'turn/end'>         // location-index.ts:132
  readonly status: 'open' | 'closed' | 'unknown'
  readonly steps: readonly StepLocation[]
}
```

### 2. 我们的

`HistoryMessage`（`frontend/src/shared/api/conversationPayloads.ts:46-53`）
→ `HistoryEvent`（`:30-44`）→ `MessagePart`（`:21-28`）：

```ts
type MessagePart = { type?: string; text?: string; toolCallId?: string; name?: string; patch?: EditPatch }
```

前端再折成 `Block`（`frontend/src/features/conversations/parts.ts:14-25`）：
`text` 和 `tool`（后者带 `result` / `failed` / `denied` / `patch`），
然后 `buildItems` 折成 `Item`（`:102-106`）：`text` / `tools` / `diff`。

### 3. 字段对照：我们没有而他们必需的

| 他们的字段 | 出处 | 谁需要它 | 我们的 transcript 里有没有 |
|---|---|---|---|
| `turn: number` | `records.ts:72` 等，全事件携带 | 导轨、回合尾、回合折叠、`data-chat-turn` | **没有**。但**可以算**：我们已经在 `parts.ts:191` 用「user 消息的第 0 段」定义回合起点 |
| `step: number` | 同上 | 回合内的「第几次请求」，区分「过程」与「答案」 | **没有，也算不出**。Claude 的 transcript 里一个回合的多次模型调用之间没有显式边界 |
| `seq`（事件序号） | `records.ts:44` 等 | 排序、React key、`processStartSeq` 这类范围比较 | 有等价物：`historySeq`（`conversationPayloads.ts:48`），但**粒度是消息不是事件** |
| `blocks[].kind === 'reasoning'` | `records.ts:35` | `ReasoningRow` | **有但被拍平了**。`claude.ts:140` 产出 `type: "thinking"` 的 part，可 `parts.ts:82-86` 的兜底分支把它和正文**拼进同一个 text block**——思考内容现在混在回复正文里 |
| `usage` | `records.ts:75` | `TurnUsagePanel`、`StatsPills`、`ContextMeter` | **源头有，我们丢了**（本机实测，见下） |
| `timing: {stepStartTime, firstTokenTime, completedTime}` | `records.ts:51-58` | TTFT / 解码吞吐（`turn-metrics.ts:42-51`） | **没有**。transcript 只有一个 `timestamp`，拿不到首 token 时刻 |
| `providerMetadata: {provider, model}` | `records.ts:27-30` | 用量弹层里的「哪个模型」 | **源头有，我们丢了**：`message.model` |
| `isError` + `error: {name, code, reason}` | `records.ts:168-169` | 四态判定 | 部分有：`tool_error` / `tool_denied` 两种 part 类型，但没有结构化的 code |
| `meta: unknown` | `records.ts:170` | 全部结构化卡片 | **没有**（上一轮的结论：这是我们最大的缺口，要在解析器里补） |
| `interrupted?: true` | `records.ts:83` | 「已停止」标记 | **没有** |
| `subCalls: readonly ToolCallBlock[]` | `records.ts:172` | 子调用树 | **没有**，我们的工具调用是平的 |
| `shadowedItemCount` / `shadowedTokenCount` | `records.ts:193-196` | 压缩标记上的「遮了多少」 | **没有**（Claude 的压缩记录里没有这两个数） |

**实测（本机，用户自己的数据）**：Claude Code 的 transcript 每条 assistant 记录都带
`message.usage`，字段是
`{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
output_tokens_details.thinking_tokens, service_tier, …}`，同一条记录上还有
`message.model`、`message.stop_reason`、`requestId`、`timestamp`。
`packages/ai-transcript/src/claude.ts:159-163` 一个都没往 `TranscriptItem` 上带。
本机 62 个 transcript 里 `stop_reason` 的分布是 `tool_use` 5773 / `end_turn` 359 / `stop_sequence` 5，
**`max_tokens` 零次**——所以 `TurnMaxTokensNode` 那一类在我们这儿暂时没有对应物。

### 4. 压缩标记：上一轮挂账的那条，查清了

上一轮「还要先查清楚才能动的」第 1 条问：CLI 自己的压缩痕迹我们现在怎么画的。

**实测**：Claude Code 把 `/compact` 之后的续接写成一条普通记录：

```
type: "user"，message.role: "user"
isCompactSummary: true
isVisibleInTranscriptOnly: true
正文开头逐字是：This session is being continued from a previous conversation that ran out of
context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ...
```

本机 62 个 transcript 里 3 条命中（两个项目各一条 + 一条子 agent 的）。

`packages/ai-transcript/src/claude.ts:103-106` 的过滤只认 `isSidechain` 和五个 `row.type`，
**这两个字段都不读**。结果：

- 它进 `parts.ts` 时 `role === "user"`，于是 `buildItems`（`parts.ts:191`）判定
  `isUser && index === 0` → `turnStart: true`，**画出一条回合边界**；
- `ConversationDetail.tsx:428` 据此加 `mt-3 border-t pt-3`，`TranscriptItem` 标上「你」；
- `TextBlock`（`:298-316`）因为 `mine === true` 而**不折叠**（`collapsible = !mine && …`），
  几千字原样铺开。

也就是说：**一次压缩在我们的界面上是「用户忽然发了一条几千字的、他从没写过的消息，并开了一个新回合」。**

dsh 的规则可以逐字抄（`CompactionItem.tsx:1-2`、`records.ts:175-181`）：

> A compaction marker does not replace shadowed transcript rows. … the marker reports where the
> model stopped seeing that history, it does not replace it.

被遮蔽的历史照常显示，标记本身是一条可展开的分隔行。**两个数（遮了几条、几个 token）我们拿不到**
（Claude 不写），所以摘要位退回 `CompactionItem.tsx:47` 已经准备好的那条降级路径：
`fallbackSummary ?? t('message.compaction.expand')`。

---

## 三、markdown（Q3）

### 1. 他们用的是什么

**不是 remark / rehype，是自己写的 mdast → React 直渲管线**，12 个文件 / 3199 行，
全在 `ui-primitives/src/markdown/` 下：

| 文件 | 行 | 干什么 |
|---|---|---|
| `render.tsx` | 685 | mdast 节点 → React 元素。**不产 HTML 字符串，没有 `dangerouslySetInnerHTML`** |
| `highlight.ts` | 487 | 唯一的语法高亮器：`createHighlighterCoreSync` + JS 正则引擎 + CSS 变量主题 |
| `incremental.ts` | 360 | 流式增量块解析 |
| `mathCompatibility.ts` | 349 | `\(…\)` / `\[…\]` 这类兼容分隔符的 micromark 扩展 |
| `MarkdownText.tsx` | 188 | 入口，两条臂：settled 全量 / streaming 增量 |
| `CodeBlock.tsx` | 200 | 代码块（行号、复制、视口内才高亮） |
| `katex.tsx` | 90 | TeX → React（KaTeX 出 HTML，`DOMParser` 转树，再映射成 React 元素） |
| `cjkFriendlyStrong.ts` | 83 | **中文友好的 `**强调**`**：CommonMark 规则下中文旁边的 `**` 常常不生效 |
| `parse.ts` | 44 | 两套语法（见下） |
| 其余 | 713 | `plain-text.ts` / `useViewportHighlighting.ts` / `JsonBlock.tsx` |

四个关键设计：

1. **两套语法，按状态分**（`parse.ts:1-9` 的注释写得很直白）：
   `parseGfm`（`:26-31`）= GFM + CJK 强调，**不含 math**；
   `parseGfmWithMath`（`:39-44`）= 再加 `mathCompatibility()` + `math()`。
   流式时用前者，落定后用后者——**「一个 `$$` 块在流式期间是段落，落定后才是公式，这是有意的」**，
   为的是半截 TeX 不要一路闪 KaTeX 报错。
2. **增量解析**（`incremental.ts:1-29`）：CommonMark 的块级解析是按行的，追加文本只会重塑
   「解析前沿」——最后一个顶层块。所以除了末尾 `UNSTABLE_TAIL_BLOCKS = 2` 个块（`:38`）之外
   全部冻结成缓存的 React 元素，每个 chunk 只重解析尾巴。
   注释里承认一个已知偏差：跨过冻结边界的引用式链接/脚注会先按字面渲染，等落定全量解析自愈。
3. **同步高亮**（`highlight.ts:1-19`）：JS 正则引擎（不要 oniguruma 的 wasm），
   **启动集只有 TypeScript / shell / JSON 三个语法**（`:42`），
   read 卡片要的另外 20 多个语言按需 `import()`（`:53-90`），
   注释里给了数字：「a session that never opens a read card in one of those languages pays
   neither the ~1.6 MB of grammar modules nor their synchronous init」。
4. **KaTeX 不可选**：`MarkdownText.tsx:23` 无条件 `import 'katex/dist/katex.min.css'`，
   `render.tsx:26` 无条件 `import { renderTexToReact } from './katex.tsx'`，
   而 `katex.tsx:20` 是 `import katex from 'katex'`。**即使永远走 `parseGfm` 那条不含 math 的臂，
   KaTeX 的 JS + CSS + 字体也进包。**

### 2. 我们用的是什么

`frontend/src/shared/markdown.ts`（52 行）：

- `renderMarkdown`（`:19-23`）：`markdown-it`，**每次调用 new 一个实例**，`html: false`
  （`:13-18` 的注释给的理由是布局稳定，不是防谁）。产出 HTML 字符串。
- `useCodeHighlight`（`:31-51`）：挂载后扫 `pre > code`，逐个异步换成高亮版。
- `ConversationDetail.tsx:288-296` 的 `Prose` 把两者接起来，**渲染失败退回纯文本**。
- `shared/code-highlight.ts:64-70`：`highlightCode` 里 `await import("./code-highlight-shiki")`，
  语言与主题都在那一侧惰性加载。`code-highlight-shiki.ts:1-9` 的注释记着实测：**这一拆省 54 KB（gzip）**。

### 3. 换过去得到什么、失去什么，以及代价（本机实测）

用本仓库的 `node_modules` + esbuild（`--bundle --minify --format=esm --platform=browser`）现场测：

| 依赖 | minified | gzip |
|---|---|---|
| `markdown-it`（我们现在的） | 98 686 B | **40 499 B** |
| `mdast-util-from-markdown` + `mdast-util-gfm` + `micromark-extension-gfm`（他们的解析侧，不含 math） | 83 658 B | **25 780 B** |
| `shiki/core` + JS 引擎 + 三个启动语法（`highlight.ts:42` 那一组，**静态 import**） | 393 083 B | **76 344 B** |
| `katex` | 未安装，**没测** | — |

净账（不算 KaTeX、不算 `render.tsx` 自身那 685 行）：
**−40.5 + 25.8 + 76.3 = +61.6 KB gzip**。

**但这笔账要落在正确的位置上**：`ConversationDetail` 是懒加载的
（`frontend/src/features/terminal/view/TerminalLens.tsx:16`，而且 `LeftRail.tsx:3-9` 的注释
专门说明了 `BookmarksDialog` 曾经是「这条链的另一半」），所以这 61.6 KB **不进首屏，
进的是「第一次打开对话视图」那一次**。AGENTS.md 第四节记的 386.3 → 560.8 KB 那条讲的是
Shell 首屏，和这里不是同一格。**这一点要说清楚，否则会把一个可接受的成本说成不可接受。**

**换过去得到的**：

- **GFM 表格 / 删除线**——我们已经有（markdown-it 默认预设就含）。**不是收益。**
- **脚注**——markdown-it 要插件，他们内建。小收益。
- **TeX 数学**——真收益，但要 KaTeX 的全部体积。
- **中文友好的 `**强调**`**（`cjkFriendlyStrong.ts`）——**这条对中文界面是真收益**，
  而且是纯语法扩展，理论上可以只抄这 83 行去配 markdown-it（未验证可行性，列为存疑）。
- **不经 HTML 字符串**——安全性上更好，但我们 `html: false` 已经封掉了那条路。
- **代码块的行号 / 复制 / 视口内才高亮**——真收益，而且 **`CodeBlock.tsx` 已经在
  `frontend/src/vendor/dsh/markdown/` 里了**，不需要换 markdown 引擎就能用。
- **增量流式渲染**（`incremental.ts` 360 行 + `MarkdownText.tsx:65-146` 的 `StreamingRenderer`）——
  **对我们是零收益**。`ConversationDetail.tsx:25-30` 的第一句就写着「只读历史」：
  消息从 transcript 一条条到达，每条到达时正文**已经是完整的**。
  我们的 `Prose`（`:291`）用 `useMemo` 按 `value` 缓存，一条消息只渲染一次。
  360 行解决的是「同一条消息的文本每 16ms 变长一次」，我们没有这个场景。

**失去的**：

- **懒加载的 shiki**。我们现在是「有代码块才去拉 shiki」；他们是「三个语法静态进包」。
  实测差 76.3 KB gzip，而对话里**多数消息没有围栏代码块**。
- **渲染失败退回纯文本**那条兜底（`ConversationDetail.tsx:293-295`）。他们的 React 直渲没有
  等价物——mdast 渲染抛异常就是整条消息白掉。要保住得自己包一层 ErrorBoundary。
- **`markdown-it` 的可定制点**。`renderMarkdown` 的 `customize?` 形参（`markdown.ts:19`）
  正是给 `plugins/markdown/markdown.tsx:7` 那个文件预览插件用的（图片相对路径改写、
  文件链接跳转）。**换引擎要连那个插件一起改**——它是 `shared/markdown.ts` 的另一个消费方。

### 4. 结论，以及另一路 agent 已经做的决定

**不换。** 而且这个结论不是我一个人得出的：另一路 agent 在 vendor `ui-primitives` 时
已经独立撞上同一件事，并且把判断写进了
`frontend/src/vendor/dsh/markdown/MarkdownText.tsx:1-18`——那是全 vendor 目录里**唯一一个
不是逐字照抄的文件**，是一个同签名的纯文本替身，理由写着：

> 整棵搬进来会同时违反这次 vendor 的两条前提——「零运行时依赖」和「删掉用不上的」：
> 它唯一的消费方是 WebBlock 里 web_search 结果的那段 answer，为它拖进一个带 LaTeX
> 数学排版的 markdown 引擎不划算。

**两条独立的路径得出同一个结论，这条可以当定论。**

**但有一件事必须提醒（本轮新发现，属于另一路 agent 的地盘，只报不改）**：
`frontend/src/vendor/dsh/markdown/highlight.ts:24-26` 是**静态** import 三个语法模块，
而 `vendor/dsh/index.ts` 里 `export { CodeBlock } from './markdown/CodeBlock.tsx'`
把它接到了桶文件上。**任何 import 这个桶的模块都会同步拉进 76.3 KB gzip 的 shiki**，
这和我们 `code-highlight.ts:57-63` 的注释（「shiki 那一坨只在这里**动态**导入
——它是首屏里第二大的一块」）是相反的取向。
另外 `@shikijs/langs` 目前只是 `shiki` 的传递依赖，**不在 `frontend/package.json` 里**。
这两件事不影响本文的结论，但值得那一路确认一次。

---

## 四、回合（Q4）

### 1. 回合从哪来：host 发的号，不是 UI 算的

`location-index.ts:299-343` 把事件流折成回合/步的坐标；`:418-469` 增量更新。
判据只有四个事件类型（`:418-419`）：

```ts
if (event.type !== 'turn/start' && event.type !== 'turn/end'
  && event.type !== 'step/start' && event.type !== 'step/end') { … }
```

`TurnLocation`（`contract/conversation.ts:92-97`）直接把 `turn/start` 和 `turn/end` **事件本身**
存在 `start` / `end` 上，`status` 是 `'open' | 'closed' | 'unknown'`。
一个回合里可以有多个 step（一次 step = 一次模型请求），`steps: readonly StepLocation[]`。

**对我们**：`turn` 我们**算得出**（`parts.ts:191` 的「user 消息的第 0 段」就是同一条定义，
`:138-140` 的注释把理由写清楚了）；`step` 我们**算不出**，Claude 的 transcript 里
一个回合内多次模型调用之间没有任何显式边界。
`status` 我们只有近似：最后一条消息之后没有新消息 ≠ 回合已关闭。

### 2. 边界怎么画：**不画**

本机核对 `chat/ChatView.module.css`：**没有任何回合分隔线、回合背景、回合外框**。
`.column` 下唯一的规则是相邻行之间 16px（`:49-51`），而且写得很讲究——
`:not([hidden]):not(.flowItem:empty)`，因为空的和隐藏的 seat 不该贡献间距（`:66-71`）。
回合折叠打开/关闭时只改这个间距：`.flowItem[data-turn-process-answer]` 把间距收成 8px（`:62-64`），
注释是「a closed process reads as one summary immediately followed by its answer」。

回合号只以 **data 属性**存在（`ChatNodeSeat.tsx:132` 的 `data-chat-turn={turn}`），
给 `ChatView.tsx:55-71` 的 `turnAtLine()` 做命中测试用——**是给导轨读的，不是画出来的**。

> **对我们**：我们画线（`ConversationDetail.tsx:428` 的 `mt-3 border-t border-border/40 pt-3`）。
> 这**不是错的**，是两种不同的取向：他们有导轨所以不需要线，我们没有导轨所以线是唯一的边界信号。
> **不要因为他们没有就把我们的线去掉。**

### 3. 回合导航：`TurnNavigator.tsx`（222 行 + 234 行 css）

- 固定 10px 间距的刻度条（`:19-23` 的三个常数：`TURN_SPACING_PX = 10`、
  `RAIL_INSET_PX = 6`、`FADE_PX = 24`），溢出时自己滚，两端做遮罩淡出。
- 活动刻度离开视口就居中，**但指针在导轨上时不动**（`:111-120`，
  `pointerInsideRef` 的注释是「follow must not move it under the hand」）。
- 悬停出预览卡，内容来自 `turn-navigation.ts:78-95` 的 `turnNavigationItem()`：
  `{turn, anchorKey, prompt, response}`，prompt 取 user 节点的文本、response 取**最后一个**
  有文本的 assistant 节点。
- 预览有预算：`PROMPT_PREVIEW_LIMIT = 50` / `RESPONSE_PREVIEW_LIMIT = 120`（`:11-12`），
  而且 `preview()`（`:18-40`）有**逐段上限**，注释说明了为什么：
  「this runs on every structural rail update, so one huge text block must not be
  concatenated (and regex-normalized) whole for a preview this short」。

> **对我们**：`TurnNavigator.tsx` 是甲档里最大的一块（222 行），而且它需要的数据我们**全都有**
> ——回合号、锚点 key、提问首句、回答首句，全在 `buildItems` 的输出里。
> 但它也需要 `ChatView.tsx` 那套滚动锚定（`:55-71` `turnAtLine`、`:80-110` `pagingAnchor`、
> `:312-396` 的活动回合跟踪）才有「活动刻度」这个概念，而那一套是丙档。
> **导轨本身可搬，跟随逻辑要自己写**——我们有 `shared/followBottom.ts`，但它回答的是别的问题。

### 4. 回合用量：`turn-tail` + `TurnUsagePanel`

`TurnTailChatData`（`contract/chat-nodes.ts:86-98`）是回合尾页脚的载荷：

```ts
turn; seq; time
closing: FinalAssistantChatData | null      // 这个回合里最后一条有内容的 assistant
branchUnavailable: boolean
ttftMs?: number
tokensPerSecond?: number
tokenUsage?: TurnTokenUsage
```

`TurnTokenUsage`（`:69-83`）的设计值得单独记一条：
**`cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` / `routes` 四个字段的注释
全是「Present only when every attempt reported the bucket」**——
一个回合里只要有一次请求没上报某个桶，这个桶就整个不出现，**而不是当 0 加进去**。
这是「不完整的统计不许伪装成完整的」，和我们 `parts.ts:209-220` 里
「`truncated` 是黏性的，截断过的数字只是个下界」是同一条规矩。

`TurnUsagePanel.tsx`（182 行）是它的呈现：一个药丸显示紧凑总数，点开一个 portal 弹层，
里面是精确数、模型路由、缓存命中率（`:49-51`，分母是 `totalTokens - outputTokens`）。
另有一个 `TurnTimePanel` 走同一套壳（`stat-dialog.ts` 66 行）。

TTFT / 吞吐由 `contract/turn-metrics.ts:72-98` 的 `deriveTurnMetrics()` 折出来，
依赖 `AssistantMessageNode.timing` 的三个时刻。

> **对我们**：
> - **`TurnUsagePanel` 是可行的**，但不是今天：需要先在 `claude.ts` 把 `message.usage`
>   带出来（本机实测数据齐全，见第二节），再在 `MessagePart` 之上加一个**消息级**字段。
>   这是解析器改动，而且**每家 CLI 一份**——上一轮已经记过这条成本。
> - **TTFT / 吞吐不可行**：`timing` 需要 `step/start` 和「首 token 时刻」，transcript 里没有。
>   **不要用 `createdAt` 的差去伪造它**——那是两条消息落盘时刻的差，不是首 token 延迟。
> - `TurnTokenUsage` 那条「桶不全就整个不给」的规矩**现在就可以抄进约定**，
>   即使用量字段还没有。

### 5. 回合过程折叠：`turn-process`（这一轮最值钱的一件）

**它做的事**：一个回合里，从「过程开始」到「最终回答」之间的**所有行**——
中间的 assistant 消息、工具调用、思考、重试——全部收进一个可展开的控制行，
默认关闭，行文是「5 次工具调用 · 2 条消息」（`TurnProcessNodeView.tsx:38-40`）。

**范围怎么定**（`conversation-nodes/turn-process.ts:124-168` 的 `processSpec()`）：

- `answerAnchorSeq` = 这个回合**最后一个 step** 里那条 assistant 消息，且它必须
  有可见回复、且**不含任何 `tool-call` 块**（`:117-122` 的 `latestAnswer()`）。
  没有这样一条就 `answerAnchorSeq: null`，整个折叠不成立。
- `processStartSeq` = `turn.start.seq`，取不到就退到「最早的一条过程证据」（`:149-162`）。
- 三个计数（`:170-206` 的 `updateProcessState`）：`messageCount` 只数**有回复内容**的
  assistant 消息、`toolCallCount` 和 `subagentCount` **分开数**（`:179-185`），
  子 agent 的判据是 `isSubagentDelegationTool()`（`contract/turn-process.ts:59-61`：
  `name === 'subagent' || name.startsWith('subagent_')`）。

**谁不参与折叠**（`contract/turn-process.ts:20-33`）：
`system-prompt` / `user` / `steering` / `turn-process` / `turn-error` / `turn-max-tokens` / `turn-tail`
——**用户说的话永远不折**，回合级的错误也不折。

**怎么折**（`ChatNodeSeat.tsx:69-102`）：不是把行从数组里删掉，而是每一行自己算
`processMember`（`:69-73`：`anchorSeq >= processStartSeq && anchorSeq < answerAnchorSeq`），
成员且未展开就 `processHidden`，交给 `useSearchableHidden`（`chat/searchable-hidden.ts`，31 行）
渲染成 `hidden="until-found"`——**浏览器的页内查找仍然能命中被折叠的内容，并自动展开**。

还有两道闸（`ChatNodeSeat.tsx:62-68` 的 `processWindowReady`）：
必须 `compactTranscript`（一个用户设置，`settings/TranscriptViewRow.tsx`）、
回合必须已关闭、**历史必须已经加载完整**（`!historyIncomplete`）——
**加载不全的窗口里不许折叠**，因为算不准「最后一条回答是哪条」。

> **对我们**：**这是整份笔记里性价比最高的一条。**
> - 我们**已经有**回合范围：`buildItems`（`parts.ts:141-199`）里的 `turnTools` / `turnKey`
>   就是「这个回合到目前为止攒了什么」，`closeTurn()`（`:149-153`）已经在回合结束时
>   落一个汇总条目（`TurnDiffItem`）。
> - 我们**已经有**「一组连续工具调用收成一行」（`Item.kind === 'tools'`，
>   `ConversationDetail.tsx:365-390` 的 `ToolsItem`，门槛 `MIN_GROUPED_TOOLS = 3`）。
> - 缺的只是**把范围从「连续的工具调用」放大到「整个回合的过程」**，
>   并把最后那条纯文本回答留在外面。判据可以直接照抄：
>   「最后一条不含工具调用的 assistant 文本块」就是答案，前面的全是过程。
> - **`hidden="until-found"` 那 31 行必须一起抄。** 没有它，折叠就意味着 Ctrl-F 搜不到——
>   对一个「只读历史」的视图来说这是功能倒退。
> - **两道闸也要抄**：我们的 `history.hasMore`（`history.ts:21`）正对应 `historyIncomplete`。
>   往回翻还没翻完时不许折叠。

---

## 五、最小可行的搬法（Q5）

三步，**严格按这个顺序**，每一步都能单独上线，都不需要先拆掉现有的东西。

### 第一步：补 `ReasoningRow` + 修压缩标记（不碰 markdown、不碰回合）

**为什么排第一**：这两条都是**现在显示错了**，不是「显示得不够好」。

1. **思考内容现在混在回复正文里。** `claude.ts:140` 产出 `type: "thinking"` 的 part，
   但 `parts.ts:82-86` 的兜底分支不认它，把它和 `text` 拼进**同一个** text block
   （`:85` 的 `last.text += "\n\n" + value`）。
   改动：`parts.ts` 的 `Block` 加一个 `{ kind: "reasoning"; text: string }`，
   `groupMessages` 里给 `part.type === "thinking"` 单开一条分支；
   `ConversationDetail.tsx` 的 `TranscriptItem` 多一个分支渲染 `ReasoningRow`。
   `ReasoningRow.tsx`（64 行）**函数体一行不动**，只换 `t` 和 CSS——
   它要的 `DisclosureRow` 和 `IconThinkOutline14` 已经在 vendor 里。
2. **压缩标记现在画成用户发言。** 见第二节第 4 小节。
   改动：`claude.ts` 的 `normalize` 认 `row.isCompactSummary === true`，
   产出一个 `type: "compaction"` 的 part（或一个消息级标记）；
   `parts.ts` 加 `{ kind: "compaction"; summary: string }`；
   `ConversationDetail.tsx` 用 `CompactionItem` 的形状画一条分隔行。
   **两个计数拿不到，走 `CompactionItem.tsx:47` 已有的降级路径。**
   **被遮蔽的历史照常显示**——`CompactionItem.tsx:1-2` 的那句话直接抄进注释。

**可见改善**：思考不再污染回复正文；一次压缩不再冒充成用户发言、不再凭空多一条回合边界。
**改动面**：`parts.ts` + `ConversationDetail.tsx` + `claude.ts`（约 60 行），
新增 vendor 文件 1 个（`ReasoningRow`）+ 1 个借形状（`CompactionItem`）。
**风险**：`parts.ts` 有测试（`frontend/tests/`），`Block` 加成员是加法。

### 第二步：回合过程折叠（复用现成的回合范围）

在 `buildItems` 里给每个回合多算一条：
「这个回合的最后一个 `kind === "text"` 且 `role === "assistant"` 的条目是哪个」——
它之后的是尾，它之前（且在本回合内）的是**过程**。
然后：

- 过程条目加 `processMember: true`；
- 回合开头插一个 `{ kind: "turn-process", toolCalls, messages }` 条目；
- `ConversationDetail.tsx` 用 `TurnProcessNodeView`（60 行，甲档）画控制行；
- 折叠用 `hidden="until-found"`（`searchable-hidden.ts`，31 行，甲档）；
- 闸门：`!history.hasMore`（`history.ts:21`）时才允许折叠。

**可见改善**：这是**最大的一块**。一个「提问 → 十几次工具 → 回答」的回合从十几行缩成
「提问 / 折叠行 / 回答」三行，而 Ctrl-F 仍然搜得到里面的内容。
**不必先拆掉什么**：`ToolsItem` 的成组（`MIN_GROUPED_TOOLS = 3`）留在原地——
展开过程之后它照旧生效，两层折叠是嵌套关系不是竞争关系。
**改动面**：`parts.ts` 加一个 pass + `ConversationDetail.tsx` 加一个分支，约 120 行。

### 第三步（有条件）：回合用量

**前置**：`claude.ts` 把 `message.usage` / `message.model` 带出来，
在 `HistoryEvent` 上加一个消息级的可选字段（**不是 `MessagePart`**——usage 属于整条消息）。
**其他六家 CLI 各写一份**，而且**没有的就是没有，不许估**。

有了之后 `TurnUsagePanel.tsx`（182 行）+ `token-format.ts`（98 行）+ `stat-dialog.ts`（66 行）
是甲档，只要把 `stat-dialog` 的两个定位 hook 换成 `@floating-ui/react`。
`TurnTokenUsage` 那条「桶不全就整个不给」（`contract/chat-nodes.ts:75-82`）照抄。

**明确不做的**：TTFT 和吞吐（`turn-metrics.ts`）——数据不存在（见第四节第 4 小节）。

### 排在三步之外的：`TurnNavigator`

222 行甲档 + 234 行 css，数据我们全有，但「活动回合跟踪」要自己写
（他们那套在 `ChatView.tsx:55-71`、`:80-110`、`:312-396`，是丙档）。
**先做完前三步再评估**：如果回合折叠之后一屏能看到五六个回合，导轨的边际价值就小了。

---

## 六、得不偿失的两块（量化）

### 1. `AssistantMarkdown` 那一棵树 —— 不要搬

| 量 | 数 |
|---|---|
| 要搬的行数 | `markdown/` 12 文件 / **3199 行**（其中 `render.tsx` 685、`highlight.ts` 487、`incremental.ts` 360、`mathCompatibility.ts` 349） |
| 要新装的 npm 包 | **8 个**：`katex`、`micromark-core-commonmark`、`micromark-util-{character,classify-character,symbol,types}`、`micromark-factory-space`、`micromark-extension-math`、`micromark-util-sanitize-uri`、`mdast-util-math`（清单出自 `vendor/dsh/markdown/MarkdownText.tsx:6-9`，与我们 `node_modules` 的缺项核对一致） |
| 实测体积（不含 KaTeX） | **+61.6 KB gzip** 进对话分块 |
| 我们会失去的具体能力 | ① shiki 的懒加载（实测 −54 KB gzip，`code-highlight-shiki.ts:1-9`）；② 渲染失败退回纯文本的兜底（`ConversationDetail.tsx:293-295`）；③ `renderMarkdown` 的 `customize?` 扩展点，连带 `plugins/markdown/markdown.tsx` 要一起改 |
| 我们会得到而且用得上的 | 脚注、TeX 数学、**中文友好的 `**强调**`**、代码块行号/复制 |
| 我们会得到但用不上的 | **增量流式渲染（`incremental.ts` 360 行 + `StreamingRenderer` 82 行）——我们是只读历史，`ConversationDetail.tsx:25-30` 第一句就写着这件事，正文到达时已经完整** |

**结论**：三项收益里两项（代码块装饰、中文强调）**不需要换引擎也能拿到**——
`CodeBlock.tsx` 已经在 vendor 里，`cjkFriendlyStrong.ts` 是 83 行的独立语法扩展。
剩下真正要换引擎才有的是脚注和数学，而代价是 3199 行 + 8 个包 + 61.6 KB。
**不划算，而且另一路 agent 已经独立做了同样的判断并落地。**

### 2. `ui-conversation` 整包 —— 不要搬

| 量 | 数 |
|---|---|
| 总行数 | **10944 行 ts/tsx + 1766 行 css** |
| 「不能搬」占比 | **10326 / 10944 = 94.4%** |
| 剩下的 618 行 | 三个 contract 类型文件，**是字段清单，读完就够了，不该进我们的仓库** |
| 最大的两块 | `input/` 20 文件 3117 行（自研 contenteditable 编辑器）、`conversation/` 7 文件 2215 行（session 事件装配器） |
| 耦合点 | `service.ts` 603 行是一个 cordis 服务；`apply.ts` 424 行注册 5 类 slot；`skeleton/` 11 文件全部经 `renderSlot` 组合 |
| 我们已有的等价物 | `ConversationComposer.tsx` 93 + `useOutgoing.ts` 91 + `outgoing.ts` 79 + `recovery.ts` 139 + `history.ts` 83 = **485 行**，而且它贴着 daemon 的投递语义（`DeliveryState` 六态 + `reason`，`conversationPayloads.ts:61-70`），**那是他们没有的问题** |

**结论**：他们那 10944 行解决的是「我自己就是 agent，输入直接进我的 agent loop」；
我们解决的是「输入要投进一个别人的 TUI，可能投不进去、可能投了不确定成没成」。
**用 10944 行换掉我们那 485 行，会把一个我们已经解对的问题重新弄错。**

---

## 七、存疑与未验证

1. **没有跑过他们的任何东西。** 没装依赖、没跑测试、没起 dsh。所有行为结论都是读代码读出来的。
   `ui-chat` 和 `ui-conversation` 的 `tests/` 目录**一行都没读**。
2. **KaTeX 的体积没测**（包没装）。第三节的 +61.6 KB **不含它**，
   而 `render.tsx:26` 是静态 import，真要换引擎时它一定在账上。
3. **`vendor/dsh/tokens.css` 是否覆盖 ui-chat 用到的 34 个 `--dsw-*` 没有逐个核对。**
   它自述接了 28 个，而 ui-chat 的 CSS 里出现了
   `--dsw-alias-state-business-primary`、`--dsw-elevation-panel`、`--dsw-font-xxs-12`、
   `--dsw-font-xs-strong-13` 这几个名字——**搬甲档 CSS 之前要先核这一步**。
4. **`cjkFriendlyStrong.ts` 能不能移植到 markdown-it 没验证。** 它是 micromark 的语法扩展
   （83 行），markdown-it 的规则链是另一套 API，「照着改一个 markdown-it 规则」只是推测。
5. **`ChatView.tsx` 881 行只读了约三分之一**（开头的滚动/锚点工具 + 结尾的 render）。
   中间 `:240-755` 那段（活动回合跟踪、分页锚定、图片加载、fork）没通读，
   第四节第 3 小节关于「跟随逻辑要自己写」的判断建立在部分阅读上。
6. **`conversation-nodes/chat-snapshot-builder.ts` 1078 行只读了前 90 行。**
   归到丙档的依据是它的 import 与前 90 行的可变仓库/订阅源结构，不是通读。
7. **`step` 在别家 CLI 的 transcript 里有没有对应物没查。** 本轮只核了 Claude。
   codex / gemini / grok / qwen / opencode 的记录格式可能带请求边界，
   如果带，第四节「step 算不出」这条要按家重判。
8. **本机实测的 transcript 样本是用户自己的 62 个文件**，压缩记录只命中 3 条。
   `isCompactSummary` 的字段名和位置在旧版本 Claude Code 里可能不同——
   写解析器时要按「没有就退回现状」的方式加，不能假定它一定在。
9. **`ui-theme` 的 948 行 / 357 个令牌只数了数，没读**。
   「只用到 34 个」是从 ui-chat 的 css 反查出来的，如果某个 `--dsw-*` 的定义里又引用了
   别的 `--dsw-*`，实际要接的数量会更多。
10. **`@shikijs/langs` 不在 `frontend/package.json` 里**这件事只是 `git diff` 和 `ls` 的观察，
    没有确认另一路 agent 是否打算补上——属于那一路的地盘，本文只报不改。

---

## 八、一句话总结

`ui-chat` 的 9670 行里，**真正该搬的是 1219 行，而最值钱的三样是
`ReasoningRow`（64 行）、`turn-process` 折叠（约 120 行改造）、`CompactionItem` 的呈现规则（一句注释）**；
`ui-conversation` 的 10944 行一行都不该搬。
markdown 引擎不换——两条独立路径得出了同一个结论。
顺手结清的一笔旧账：**我们现在把 CLI 的压缩摘要画成了一条用户发言**，这是第一步就该修的。
