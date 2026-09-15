# DeepSeek Harness UI 积木 → 我们的数据：适配层规格

调研对象：`research/third-party/deepseek-harness/`（MIT，master `0d1f500`）。
**这是一份只读调研，没有改动任何代码。**

路径简写（下文所有 `文件:行号` 都按这个展开）：

| 简写 | 实际路径 |
| --- | --- |
| `P/` | `research/third-party/deepseek-harness/packages/client/ui-primitives/src/` |
| `M/` | `research/third-party/deepseek-harness/packages/client/ui-tool/src/client/tool/models/` |
| `F/` | `frontend/src/` |
| `T/` | `packages/ai-transcript/src/` |

---

## 结论先行

**1. 八个积木里，四个今天就能填满，两个能填到「能上但会撒谎」，两个填不了。**

| 积木 | 今天能不能上 | 一句话 |
| --- | --- | --- |
| `StateDot` | ✅ 能，零缺口 | 我们的 `ToolsStatus` 三态直接对上，`denied` 还能多点亮一个 `warning` |
| `DisclosureRow` | ✅ 能，零缺口 | 纯 UI 壳，props 全是我们自己决定的值，不碰 transcript |
| `CodeBlock` | ✅ 能，零缺口 | 只要 `code` + 两个 i18n 串；`lang` 从 `file_path` 后缀推 |
| `DiffBlock` | ⚠️ 能上，但**形状要转换、而且会丢「被截断」** | 它要 `oldText`/`newText` 全文，我们只有 unified hunk |
| `TerminalBlock` | ⚠️ 能上，但**失败的命令会被画成绿色的「完成」** | 缺退出码时它按"干净退出"处理，这是它源码里明写的行为 |
| `ReadBlock` | ⚠️ 只对 Claude 成立，且 `totalLines` 是编的 | 行号+正文能从结果文本解出来，文件总行数拿不到 |
| `SearchBlock` | ❌ 不能上 | grep/glob 的结构化结果**一个字段都没有**，空数组会被画成「没搜到」 |
| `WebBlock` | ❌ 不能上 | `statusCode` 是必填 `number`，我们没有；填假的就是编造 |

**2. 最要命的一条：`TerminalBlock` 缺退出码时不是优雅降级，是画错。**
`P/TerminalBlock.tsx:118-127` 的 `runState()`：没有 `signal`、没有非零 `exitCode`，就返回
`{ state: 'done', label: labels.done }`——绿点 + 「完成」。它自己的注释（`P/TerminalBlock.tsx:110-112`）
把这件事说得很直白：*"A settled command whose exit status never reached the view counts as a clean
settle: the view says it finished and says nothing went wrong."* 我们有 `block.failed`
（`F/features/conversations/parts.ts:16`），但 `TerminalBlockProps` 上**没有一个 prop 能接住它**——
只有 `exitCode: number` 和 `signal: string`。想让它显示失败就得编一个退出码。

→ **先上、后补数据是可行的，但必须把失败标记留在积木外面**（现在 `SummaryRow` 上那个行内标签，
见 `F/features/conversations/parts.ts:117` 的说明）。绝不能把 `TerminalBlock` 的状态点当成唯一的成败指示。

**3. 缺口的责任分布：主要是「我们的解析器丢了」，不是「CLI 没给」。**
实测本机 62 份 Claude transcript、22327 条记录：`toolUseResult` 里 **stdout / stderr 是两个独立字段**
（2441 条 dict 结果中 1757+396+44+32+… 条都带），Read 带 `file.totalLines`，WebFetch 带 `code`（HTTP 状态码），
WebSearch 带 `results[]`。**这些我们的 `claude.ts` 一个都没取**——它只读 `block.content` 那段拍平文本
（`T/claude.ts:146-153`）。唯一真正「CLI 就没给」的是**退出码**：22327 条记录里没有任何一个
exit / returncode / signal 字段（只有 27 条 `returnCodeInterpretation`，值是 `"No matches found"` 这种人话）。

---

## 一、两边的形状，先各摆一次

### 1.1 他们的数据是怎么来的（读他们的适配层是为了知道语义）

他们的卡片模型**不从结果文本里解析**，而是读工具在执行时投影出来的一份结构化元数据：
`block.meta`，来源是工具定义上的 `output.presentationMeta`
（`research/third-party/deepseek-harness/packages/core/tools/src/schema.ts:497`），它**随会话日志一起落盘**
（同仓 `packages/core/tools/src/presentation.ts:276`）。

于是：

| 卡片模型 | 它读什么 | 行号 |
| --- | --- | --- |
| `readCardModel` | `meta.{path, offset, lines[], totalLines, lang}` | `M/read-card-model.ts:49-72` |
| `searchCardModel` | `meta.{truncated, total, shape, files[] \| paths[]}` | `M/search-card-model.ts:82-99` |
| `webCardModel` | `meta.{truncated, sources[], answer, url, statusCode}` | `M/web-card-model.ts:58-81` |
| `diffCardModel` | `meta.diffs[]`（`{path, oldText, newText}`） | `M/diff-card-model.ts:83-89` |
| `terminalCardModel` | **例外**：没有 meta，从结果文本尾部用正则抠退出码 | `M/terminal-card-model.ts:265-271` |

`terminalCardModel` 这一处值得单独记一笔：连 DeepSeek 自己都没有把退出码做成结构化字段，
而是在结果文本末尾约定了 `\n[exit code: N]` / `\n[killed by signal: X]` 两个标记，
前端拿正则去抠（`M/terminal-card-model.ts:266-269`）。**这是一条我们抄得动的路**——见第四节。

### 1.2 我们的数据形状

```
HistoryMessage.event.data.parts: MessagePart[]      F/shared/api/conversationPayloads.ts:21-28
  └ { type?, text?, toolCallId?, name?, patch? }     ← 字段就这五个，没有第六个
       patch?: EditPatch                             F/shared/api/conversationPayloads.ts:14-18
         └ { filePath?, hunks: [{oldStart,oldLines,newStart,newLines,lines[]}], truncated }

groupMessages() 把它配对成                            F/features/conversations/parts.ts:38-92
  Block = { kind:"tool", id, name, args:string, result:string|null,
            failed:boolean, denied?:boolean, patch?:EditPatch }
                                                      F/features/conversations/parts.ts:14-25

identify.ts 再从 args 挤出                            F/features/conversations/tools/identify.ts
  ToolId   { server, tool, key }                      :11-18
  ToolArgs { raw:string, json:Record<string,unknown>|null }   :70-84
  toolSubject(args) / toolSummary(args)               :118-126 / :176-186
```

适配层能拿到的**全部输入**就是上面这些，加上会话级的
`conversation.source.cwd`（`F/shared/api/conversations.ts:17`）。

⚠️ 一个今天就存在的管道缺口：`ToolView` 的签名是 `({ block }: { block: ToolBlock })`
（`F/features/conversations/tools/registry.tsx:60`），调用点也只传 block
（`F/features/conversations/ConversationDetail.tsx:367,386`）。**cwd 现在传不下去**，要加一个 prop 或 context。

---

## 二、逐个积木的映射表

### 2.1 `TerminalBlock`（`P/TerminalBlock.tsx:44-65`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `command` | `string` **必填** | 提示符后逐字画的命令行；`\n` 会拆成多行提示符（`P/TerminalBlock.tsx:186-189`） | `toolSubject(toolArgsOf(block))`（`identify.ts:118-126`，`command` 排第一） | ✅ 全 CLI 可得（`registry.tsx:49` 已经在用它做认领条件） |
| `labels` | `TerminalBlockLabels` **必填** | 12 个文案，其中 4 个是函数 | 新增 i18n 键 | ✅ 我们的活，非数据缺口 |
| `cwd` | `string?` | 提示符标签；取路径最后一段（`P/TerminalBlock.tsx:76-81`） | `conversation.source.cwd`（`F/shared/api/conversations.ts:17`） | ⚠️ 值有，但**管道没通**（见 §1.2） |
| `home` | `string?` | cwd 等于它时塌成 `~` | — | ❌ 前端没有任何地方有 home 路径（全库 grep 无命中） |
| `output` | `string?` | 命令输出，可含 ANSI | `block.result ?? undefined` | ✅ 有，但是 stdout+stderr 拍平的一坨 |
| `exitCode` | `number?` | 非 0 就画状态药丸 | — | ❌ **全链路都没有**，见 §3.1 |
| `signal` | `string?` | 信号名，优先于 exitCode | — | ❌ 同上 |
| `running` | `boolean?` | 只画提示符行，不画输出 | `block.result === null`（`parts.ts:120` 就是这个判据） | ✅ |
| `maxLines` | `number?` | 默认 16（`P/TerminalBlock.tsx:11`） | 我们自己定 | ✅ |
| `className` | `string?` | — | 我们自己定 | ✅ |

**无处安放的输入**：`block.failed`、`block.denied`。`TerminalBlockProps` 上没有对应 prop。

### 2.2 `DiffBlock`（`P/DiffBlock.tsx:24-33`，`DiffHunk` 见 `:15-22`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `diffs[].path` | `string` **必填** | 逐字画成文件头行（`P/DiffBlock.tsx:113`） | `block.patch.filePath` | ⚠️ 我们的是**可选**的（`conversationPayloads.ts:15`）；缺了只能给 `""`，会画出一行空的路径头 |
| `diffs[].oldText` | `string \| null` | 改动前全文（含上下文），`null` = 新建 | **形状对不上**：我们有的是 unified hunk 的 `lines[]` | ⚠️ 可重建：取 `lines` 里前缀为 `' '` / `'-'` 的行去掉前缀拼回；见 §3.4 的两个损耗 |
| `diffs[].newText` | `string` **必填** | 改动后全文 | 同上，取前缀 `' '` / `'+'` | ⚠️ 同上 |
| `labels` | `DiffBlockLabels` **必填** | 7 个（`P/DiffBlock.tsx:36-43`） | 新增 i18n 键 | ✅ |
| `maxLines` / `className` | — | 默认 16（`P/DiffBlock.tsx:9`） | 自定 | ✅ |

**无处安放的输入**：`EditPatch.truncated`（`conversationPayloads.ts:17`）。`DiffBlockProps` 上没有位置，
页脚只画 `└ +N -M · K 个文件`（`P/DiffBlock.tsx:222`）。我们现在的 `PatchTool` 是显示这件事的
（`F/features/conversations/tools/PatchTool.tsx:30-31`）——**换过去就会静默丢掉**。
`bashEditDiff` 多文件时这个标志尤其重要（`T/claude.ts:42-49` 解释了为什么只带第一个文件）。

### 2.3 `ReadBlock`（`P/ReadBlock.tsx:29-44`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `lines[].number` | `number` **必填** | 文件内 1-based 行号 | 解析 `block.result`：Claude 的 Read 结果就是 `N\ttext` 每行（[实测]，见 §3.3） | ⚠️ **只对 Claude 成立**；qwen/gemini 把整个 functionResponse `JSON.stringify` 了（`T/qwen.ts:69`、`T/gemini.ts:58`） |
| `lines[].text` | `string` **必填** | 行正文 | 同上，`\t` 之后的部分 | ⚠️ 同上 |
| `totalLines` | `number` **必填** | 文件真实总行数，用来画「显示 N / 共 M」 | — | ❌ 源头有（`toolUseResult.file.totalLines`，[实测]），我们没取 |
| `label` | `string?` | 横幅标题 | `argString(args, "file_path", "filePath", "path")`（`identify.ts:102-109`） | ✅ 新数据可得；老数据预览态只剩标量时走 `args.raw` |
| `labels` | `ReadBlockLabels` **必填** | 7 个（`P/ReadBlock.tsx:47-55`） | i18n | ✅ |
| `lang` | `string?` | shiki 语法 id | 从 `file_path` 后缀自己映 | ✅ 我们的活 |
| `maxLines` / `className` | — | 默认 16（`P/ReadBlock.tsx:19`） | 自定 | ✅ |

### 2.4 `SearchBlock`（`P/SearchBlock.tsx:63-77`，公共字段 `:31-47`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `kind` | `'matches' \| 'paths'` **必填** | grep 还是 glob | `identifyTool(block.name).key`（`grep` / `glob`） | ✅ 名字层面可判 |
| `files[]`（matches） | `{path, matches:[{lineNumber, line}]}[]` **必填** | 按文件分组的命中行 | — | ❌ **零来源**。七个解析器无一产出结构化搜索结果 |
| `paths[]`（paths） | `string[]` **必填** | glob 命中的路径 | — | ❌ 零来源 |
| `total` | `number` **必填** | **截断前**的总数 | — | ❌ 零来源。工具截了多少，transcript 里没有 |
| `truncated` | `boolean` **必填** | 工具是否截了结果 | — | ❌ 零来源（`data.truncated` 不是这个意思，见 §3.5） |
| `labels` | `SearchBlockLabels` **必填** | 9 个（`P/SearchBlock.tsx:50-60`） | i18n | ✅ |

### 2.5 `WebBlock`（`P/WebBlock.tsx:23-35` / `:38-50`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `kind` | `'search' \| 'fetch'` **必填** | 哪种检索 | 工具名 | ✅ |
| `url`（fetch） | `string` **必填** | 跟随重定向后的最终 URL | `argString(args, "url")` | ⚠️ 拿得到**请求的** URL，不是最终 URL |
| `statusCode`（fetch） | `number` **必填** | HTTP 状态码 | — | ❌ 源头有（Claude `toolUseResult.code`，[实测 21 次 WebFetch]），我们没取 |
| `truncated` | `boolean` **必填** | 内容/来源被截 | — | ❌ 零来源 |
| `answer`（search） | `string?` | 供应商生成的答案，按 markdown 画 | — | ❌ 零来源 |
| `sources[]`（search） | `{url, title?, snippet?, publishedAt?}[]` **必填** | 引用来源 | — | ❌ 源头**部分**有：Claude `toolUseResult.results[].content[]` 带 `{title, url}`，**没有** snippet / publishedAt（[实测]） |
| `labels` | `WebBlockLabels` **必填** | 含一整套 `MarkdownLabels`（`P/WebBlock.tsx:56-62`） | i18n + 移植 `MarkdownText` | ⚠️ 依赖最重的一个 |

### 2.6 `DisclosureRow`（`P/DisclosureRow.tsx:7-26`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `icon` | `ReactNode` **必填** | 折叠态前导图标 | `F/shared/icons` | ✅ |
| `title` | `string` **必填** | 行标题 | `toolSummary(args) ?? (block.args \|\| block.name)`（`SummaryRow.tsx` 现在就是这个表达式） | ✅ |
| `open` / `expandable` / `onToggle` | — **必填** | 受控展开 | `SummaryRow` 里那个 `useState` | ✅ |
| `expandOnRowClick` / `previewChevron` / `keepContentWhenOpen` | `boolean?` | 交互策略 | 自定 | ✅ |
| `collapsedContent` / `children` | `ReactNode?` | 折叠态尾随内容 / 展开内容 | 状态标签、`ToolView` 的 body | ✅ |
| 5 个 `*ClassName` | `string?` | — | 自定 | ✅ |

**零数据缺口。它不碰 transcript 的任何字段。**

### 2.7 `StateDot`（`P/StateDot.tsx:22-26`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `state` | `'done'\|'warning'\|'ongoing'\|'error'\|'idle'` **必填** | 五态（`P/StateDot.tsx:8`） | `toolsStatus()`（`parts.ts:119-122`）：`running→ongoing`、`error→error`、`completed→done`；单条调用再看 `block.denied → warning` | ✅ **零缺口，而且比我们现在的三态多一档** |
| `size` / `className` | — | 默认 10px | 自定 | ✅ |

`parts.ts:112-118` 那段注释说「组头只有三种颜色，不为 denied 加第四种」——`StateDot` 的第四种
（`warning`，琥珀色）是现成的，这个理由在单条调用那一级不再成立。

### 2.8 `CodeBlock`（`P/markdown/CodeBlock.tsx:12-38`）

| 它的 prop | 类型 | 语义 | 我们从哪拿 | 缺不缺 |
| --- | --- | --- | --- | --- |
| `code` | `string` **必填** | 源码文本 | 任何一段：`args.raw`、`block.result`、Write 的 `content` | ✅ |
| `copyLabel` / `copiedLabel` | `string` **必填** | 复制按钮两态 | i18n | ✅ |
| `lang` | `string?` | 语法 id，认不出就纯文本 | 后缀映射 | ✅ |
| `streaming` | `boolean?` | 流式增量高亮 | 我们没有流式 → 恒 `false` | ✅ |
| `lineNumbers` / `showHeader` / `className` / `contentRef` | — | — | 自定 | ✅ |

**零数据缺口。** 依赖 `P/markdown/highlight.ts`（shiki），而我们 `frontend/package.json` 里已经有 `shiki ^4.4.3`。

---

## 三、填不了的那些，追到源头是谁没给

### 3.1 退出码 / 信号 —— **CLI 就没给**（唯一一条真正的上游缺口）

[实测] 本机 `~/.claude/projects/` 下 62 份 transcript、22327 条记录，对每条 `toolUseResult`
做了全树键名扫描（正则 `exit|returncode|return_code|signal|status`）：

```
命中： ('Agent','status') 34 次     ← Agent 子任务的状态，不是退出码
      ('Bash','returnCodeInterpretation') 27 次
```

`returnCodeInterpretation` 的值实测是 `"No matches found"` 这种**给人看的句子**，不是数字。
Bash 的 `toolUseResult` 键集合是 `{interrupted, isImage, noOutputExpected, stderr, stdout}`
（1757 条）及其变体（+`bashEditDiff` 396、+`gitOperation` 44、+`backgroundTaskId` 32、
+`timedOutAfterMs`、+`persistedOutputPath`…）——**没有一个是退出码**。

我们的解析器当然也没有：`T/*.ts` 全目录 grep `exit|stdout|stderr|signal|exitCode|returncode` 只有
`opencode.ts:26,96` 两处 `AbortController.signal`，和工具结果无关。

> **可行的替代**：`block.failed`（来自 `is_error`）说得出「这次不成功」，说不出「退出码是几」。
> DeepSeek 自己走的也是替代路线——在结果文本尾部约定标记再用正则抠
> （`M/terminal-card-model.ts:265-271`）。我们没有这个标记，因为标记是他们的 Host 写进去的，
> 而我们读的是别人写好的 transcript。

### 3.2 stdout / stderr 分流 —— **是我们丢了**

[实测] Claude 的 `toolUseResult` 里 stdout 和 stderr 是**两个独立字符串字段**。
抽样 4 条 stderr 非空的记录，`tool_result.content` 逐字等于 `stdout + stderr`（4/4），
**中间没有任何分隔标记**：

```
content == stdout + stderr ?  True   (4/4)
content == stderr + stdout ?  False  (4/4)
```

我们的 `T/claude.ts:146-153` 只读 `block.content`，`toolUseResult` 只被 `editPatch()`（`T/claude.ts:63-66`）
和 `toolDenialKind`（`T/claude.ts:136`）碰过。**分流信息在解析那一刻就被扔掉了**，
而它在源文件里一直都在。

`F/features/conversations/tools/BashTool.tsx:20-21` 那段注释——「拿不到 stdout / stderr / 退出码，
我们的 result 是拍平的一坨字符串，后端没有分流」——**前半句是我们自己造成的，后半句（退出码）才是上游的**。

其余六家未核实到同等结论：codex 的 `function_call_output.output` 直接是一坨（`T/codex.ts:66`），
opencode 是 `state.output` 一个字符串（`T/opencode.ts:66`），grok 是 ACP 的 content/rawOutput
（`T/grok.ts:92-96`）——协议层面就没有分流。

### 3.3 `ReadBlock` 的 `totalLines` —— **是我们丢了**

[实测] Claude 的 Read 结果：`toolUseResult = {type:'text', file:{filePath, content, numLines, startLine, totalLines}}`
（69 次 Read 调用）。抽样一条：`startLine=1, numLines=210, totalLines=210`。
而 `tool_result.content` 是 `1\timport {...}\n2\t...` 的形式——**行号和正文能解出来，总行数解不出来**
（窗口读取时尤其：`content` 只有窗口内的行）。

`totalLines` 在 `ReadBlockProps` 里是**必填**（`P/ReadBlock.tsx:36`），没有默认值。

### 3.4 `DiffBlock` 的 `oldText`/`newText` —— **形状对不上**

他们要两侧全文，自己在组件内用 `diff` 包的 `structuredPatch` 重新算
（`P/DiffBlock.tsx:71-77`）。我们拿到的已经是算好的 unified hunk（`T/claude.ts:12-29`）。
反向重建 `oldText`/`newText` 在原理上可行（按行首 `+`/`-`/` ` 分流），但有两处损耗：

1. **单行 300 字符封顶**（`T/claude.ts:11,21`）：重建出的 `newText` 是被截过的，
   `DiffBlock` 会把它当成真实内容再 diff 一次，于是长行会显示成「改了」而其实只是被截了。
2. **非字符串的 hunk 行被写成 `""`**（`T/claude.ts:21`）：前缀丢了，重建时会落进「上下文行」。

另外 hunk 之间是不连续的（各有 `oldStart`），拼成一整段 `oldText` 后行号信息消失——
`DiffBlock` 本来也不画行号（`P/DiffBlock.tsx:47-50` 的 `DiffRow` 只有 kind + text），所以这一条不是损失。

### 3.5 「工具结果被截断」—— **有一个字段，但不是这个意思**

`data.truncated` 确实存在，而且**确实会到前端**（`packages/workspace-store/src/ai-history.ts:127`
把整个 `event` JSON 原样解析回去；`:71` 在超大消息上把它强制置 true）。但：

- 它是**消息级**的，不是结果级的。七个解析器都在同一个 `add()` 里 `truncated ||= ...`
  （`T/claude.ts:116-119`、`T/index.ts:88-92`、`T/codex.ts:41-44`、`T/grok.ts:51`），
  **参数被截、正文被截、结果被截，撞的是同一个布尔**。
- 它说的是「**我们**（Roost）在预览态截了」，而 `SearchBlock.truncated` / `WebBlock.truncated`
  问的是「**工具自己**截了结果吗」（`P/SearchBlock.tsx:36-41` 写得很清楚：卡片要拿它和 `total`
  拼出「显示 X / 共 N」）。两件事。
- `F/shared/api/conversationPayloads.ts:43` 的 `data?: { parts?: MessagePart[] }` **根本没声明它**，
  前端现在拿不到（类型层面）。

→ 结论：**这两个 `truncated` 无法互相顶替。**

### 3.6 顺带发现（不属于本次任务，但影响 `TerminalBlock.output` 的质量）

[实测] codex 的 `custom_tool_call_output.output` 是一个**数组** `[{type:'input_text', text:'...'}, …]`，
而 `T/codex.ts:66` 写的是 `typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")`
——非字符串就整个 JSON 序列化。于是 codex 的命令输出到了 `block.result` 上是一串
`[{"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\n..."}]`。
喂给 `TerminalBlock.output` 会被当成终端文本逐字画出来，包括那些 JSON 括号和转义。

⚠️ 本机只有 1 份 codex 会话、1 条这样的记录，**样本量不足以断言这是 codex 的常态**。
要动 `T/codex.ts` 之前需要更多样本。

---

## 四、填不了时，积木会怎么表现（读源码确认，这条决定能不能先上）

| 积木 | 缺什么 | 源码行为 | 行号 | 判定 |
| --- | --- | --- | --- | --- |
| `TerminalBlock` | `exitCode` + `signal` | `statusText()` 返回 `undefined` → **不画药丸**；`runState()` 返回 `{state:'done', label: labels.done}` → **绿点 + 「完成」** | `:92-100`、`:118-127`、`:223` | ❌ **不是降级，是断言成功** |
| `TerminalBlock` | `cwd` | 提示符画成裸 `$` | `:216-218` | ✅ 优雅 |
| `TerminalBlock` | `home` | 不塌成 `~`，画路径最后一段 | `:76-81` | ✅ 优雅 |
| `TerminalBlock` | `output` | `output ?? ''` → 解析成一个空行 → `empty` 为真 → 画 `labels.noOutput` 占位符 | `:159`、`:195`、`:230-231` | ⚠️ 「没输出」≠「没拿到输出」，但我们有 `result === null` 可以先走 `running` 分支 |
| `DiffBlock` | `diffs` 为空 | `if (rows.length === 0) return null` —— **整个组件不渲染** | `:189` | ✅ 最干净的降级 |
| `DiffBlock` | `truncated` 无处放 | 页脚只画 `+N -M · K 个文件`，不提被截 | `:222` | ⚠️ 静默丢信息，不画错 |
| `ReadBlock` | `totalLines` 传 `lines.length` | `windowed = lines.length < totalLines` 为 false → **不画「显示 N / 共 M」那一句** | `:109`、`:127-129` | ✅ 优雅（只是少一句，不会画出错的数字） |
| `ReadBlock` | `label` / `lang` | 画成空串，横幅那一格留空 | `:125`、`:130` | ✅ 优雅 |
| `ReadBlock` | `lines` 为空 | 正文区空；复制按钮被藏起来（`lines.length > 0` 才画） | `:132` | ✅ 优雅 |
| `SearchBlock` | `files`/`paths` 为空 | `empty` 为真 → 画 `labels.noResults`（「没有结果」） | `:186`、`:253-254` | ❌ **把「我们没数据」画成「搜索没找到」** |
| `SearchBlock` | `total` 传 0 | 摘要变成「显示 X / 共 0」 | `:130-134` | ❌ 自相矛盾的一行 |
| `WebBlock`(search) | `answer` + `sources` 都空 | `empty` 为真 → 画 `labels.noResults` | `:154`、`:160-161` | ❌ 同上 |
| `WebBlock`(fetch) | `statusCode` | **必填 `number`，没有可省的写法**；画成 `HTTP {statusCode}` | `:45`、`:182` | ❌ 传假的就是编造；传 `NaN` 会画出「HTTP NaN」 |
| `WebBlock` | URL 不是 http(s) | `safeHref()` 返回 undefined → 降级成纯文本，不进 DOM 当 href | `:74-81`、`:112` | ✅ 优雅（安全设计） |
| `StateDot` / `DisclosureRow` / `CodeBlock` | — | 无必填数据缺口 | — | ✅ |

### 这一节的明确结论

**可以先上、后补数据的：`StateDot`、`DisclosureRow`、`CodeBlock`、`DiffBlock`、`ReadBlock`。**
它们缺数据时要么整个不渲染（`DiffBlock`），要么少画一块（`ReadBlock`、`CodeBlock`），
都不会把缺失说成一个具体的事实。

**`TerminalBlock` 可以先上，但有一个硬条件**：失败状态必须由积木之外的东西表达
（保留现在 `SummaryRow` 上的行内标签）。只要 `block.failed` 为真而 `exitCode` 为空，
卡片自己就会显示绿色的「完成」——`P/TerminalBlock.tsx:110-112` 的注释是把这当成**有意设计**写的
（"the view says it finished and says nothing went wrong"），它假设 Host 总能给出退出码。
我们不满足这个前提。

**`SearchBlock` 和 `WebBlock` 不能先上。** 它们缺数据时不是留白，是画出一个**内容明确而错误**的
空壳（「没有结果」/「HTTP NaN」）。这两个积木必须等后端补完才动。

---

## 五、后端缺口清单

按「补了之后能点亮哪个积木的哪部分」排序。代价一栏里，**「只对新数据生效」** 指的是
解析器改了以后只影响新写入的记录——`packages/workspace-store` 存的是解析后的
`event` JSON（`packages/workspace-store/src/ai-history.ts:95-100`），历史行不会回填。

| # | 缺口 | 补了点亮什么 | 要改哪儿 | 代价 | 只对新数据？ |
| --- | --- | --- | --- | --- | --- |
| 1 | **stdout / stderr 分流** | `TerminalBlock.output` 的质量（stderr 能单独染色）；也是「失败」的一个**间接**信号 | `T/claude.ts:146-153` 读 `row.toolUseResult.{stdout,stderr}`；`MessagePart` 加一个和 `patch` 平行的结构化字段 | **1 个解析器**（其余六家协议层就没分流，见 §3.2）+ 1 处类型 | **是** |
| 2 | **`ReadBlock.totalLines` + 结构化 lines** | `ReadBlock` 从「能上但少一句」变成完整：「显示 210 / 共 318 行」 | `T/claude.ts` 取 `toolUseResult.file.{startLine,numLines,totalLines}` | **1 个解析器** + 1 处类型。行号/正文可以先从结果文本解，不等后端 | **是** |
| 3 | **`WebBlock` 的 fetch 元数据** | 整个 `WebBlock` kind=`fetch`（`url` + `statusCode` + 可推的 `truncated`） | `T/claude.ts` 取 `toolUseResult.{url,code,bytes}` | **1 个解析器** + 1 处类型。⚠️ 只有 Claude 有；其余六家未核实 | **是** |
| 4 | **`WebBlock` 的 search 来源** | `WebBlock` kind=`search` 的 `sources[]`（只有 `url`+`title`） | `T/claude.ts` 取 `toolUseResult.results[].content[]` | **1 个解析器**。`answer` / `snippet` / `publishedAt` 仍然没有——**补完也只能点亮一半** | **是** |
| 5 | **结果级的 `truncated`** | `SearchBlock.truncated`、`WebBlock.truncated`；也让 `DiffBlock` 之外的截断能说出来 | `MessagePart` 上加一个 per-part 的截断标志（现在只有消息级的 `data.truncated`，语义还不对，见 §3.5） | **七个解析器全改**（`add()` 都要改签名）+ 类型 + `F/.../parts.ts` 的传递 | **是** |
| 6 | **`EditPatch.truncated` 的落点** | `DiffBlock` 不再静默丢「这份 diff 不完整」 | **不是后端缺口**——数据在（`conversationPayloads.ts:17`），是 `DiffBlockProps` 没有位置。要么在积木外面加一行，要么改积木 | 纯前端，0 个解析器 | 否（数据已有） |
| 7 | **cwd 传到 `ToolView`** | `TerminalBlock.cwd`（提示符从 `$` 变成 `roost $`） | `F/.../registry.tsx:60` 加 prop 或 context；`ConversationDetail.tsx:367,386` 传下去 | 纯前端，0 个解析器 | 否（数据已有） |
| 8 | **`SearchBlock` 的结构化 grep/glob 结果** | 整个 `SearchBlock`（两种 kind） | 无现成来源：需要解析各家 grep 的结果文本，或等 CLI 给结构化数据 | **最贵，而且不确定能不能做**。[实测] 本机 62 份 transcript 里 Grep/Glob 调用 **0 次**（这版 Claude Code 的搜索走 Bash），连样本都没有 | — |
| 9 | **退出码** | `TerminalBlock` 的状态药丸 + 红点，`terminalFailed` 那条语义 | **没有办法**。22327 条记录里没有任何退出码字段（§3.1）。要么说服上游写，要么接受用 `block.failed` 做二值替代 | 不可做 | — |

### 排序说明

1～4 是**同一处改动的四个分支**：都是在 `T/claude.ts` 的 `normalize()` 里多读几个
`row.toolUseResult` 的键，再挂到 `MessagePart` 上一个新的结构化字段（和 `patch` 平行）。
它们共享同一份「加字段 + 改类型 + 前端传递」的固定成本，所以**一起做比分四次做便宜得多**。

5 是唯一要动七个解析器的，也是唯一卡着 `SearchBlock`/`WebBlock` 上线的通用缺口——
但它排在 3、4 之后，因为那两个积木还各自缺别的必填字段，光有 `truncated` 点不亮。

6、7 是纯前端的，**今天就能做，不用等任何后端改动**。

8、9 单独列在最后：8 是「不确定能不能做」，9 是「确定做不了」。

---

## 附：移植依赖

| 积木 | import 了什么 | 我们有没有 |
| --- | --- | --- |
| `StateDot` | `clsx` + 自己的 CSS module | ❌ `clsx`（`frontend/package.json` 里没有） |
| `DisclosureRow` | `clsx` + `icons/` | ❌ `clsx`，图标可换成我们的 |
| `TerminalBlock` | `ansi.ts`、`head-tail-cap.ts`、`use-copy-feedback.ts`、`Pill`、`StateDot`、`clsx` | ✅ `ansi.ts` 已抄进 `F/shared/terminal-text/ansi.ts`；`anser` 已在依赖里 |
| `DiffBlock` | **`diff` 包的 `structuredPatch`**、`FoldToggle`、`clipboard.ts` | ❌ `diff` 是新依赖 |
| `ReadBlock` | `markdown/highlight.ts`（**shiki**）、`FoldToggle` | ✅ `shiki ^4.4.3` 已在依赖里 |
| `CodeBlock` | `markdown/highlight.ts`（**shiki**）、`useViewportHighlighting` | ✅ 同上 |
| `SearchBlock` | 只有 `head-tail-cap.ts`、`use-copy-feedback.ts`、`clsx` | ✅ 最轻（可惜数据最缺） |
| `WebBlock` | **`markdown/MarkdownText.tsx`**（micromark + mdast + katex 一整串） | ❌ 最重的一个 |

`clsx` 是八个里七个都要的，`P/` 下几乎每个组件都 `import clsx from 'clsx'`。

所有 `*Labels` 都是**必填 prop**（这个包声明自己 cordis-free，文案一律走 props，
见 `P/TerminalBlock.tsx:13-16`）。落到我们这边就是 `packages/i18n/src/`（中文）和
`src/en/`（英文）各加一组键，两份形状由 `Widen` 互相约束，少一个键 `tsc` 直接报错
（AGENTS.md 第五节）。八个积木合计约 50 个键，其中十几个是带参数的函数。
