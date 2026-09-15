# Happier：GUI 工具渲染器研究

研究日期：2026-09-14。源码位于 `third-party/happier/`，上游 https://github.com/happier-dev/happier 。
本次检出分支 `dev`，提交 `c4deb153e7d4740f06bfeee94b70cfda95d47068`（2026-09-14）；开发分支快照，不等同已发布版本。
Git 历史为 depth=1 浅克隆（grafted），因此无法用 blame/log 判断某段代码是新写的还是遗留。
本轮只读源码，未安装依赖、未运行 Happier 的任何测试、未跑模型会话。所有数字均由本机重新统计。

这是[上一轮 CLI 侧笔记](happier-tui-gui-sync.md)的 GUI 侧续篇：上一轮问的是"会话怎么同步"，
这一轮问的是"一次工具调用怎么画出来"。

## 结论先行

1. **代码搬不动，设计可以照搬。** `apps/ui` 是 Expo / React Native，渲染层组件全部作废；
   但"注册表 + 兜底 + 异常全在外壳"这套结构与 RN 无关，是我们能直接用的部分。
2. **最值钱的三件东西**：外壳独占异常判定（渲染器只管画成功路径）、schema 当镜头不当闸门
   （`passthrough()` + 全 optional + `_raw`）、生产侧归一化（把"completed 其实失败了"提前判掉）。
3. **`truncateDeep` 是本轮直接采纳的唯一实现思路**，位置 `apps/cli/src/agent/tools/redaction/redact.ts`。
4. **发现一处上游自己的 bug**（见"存疑与上游缺陷"第 1 条）：`ToolInlineBody` 里近百行兜底分支
   在当前提交下不可达。我们的接缝里不要复制这个形状。

## 一、技术栈与可移植性（已从源码确认）

### 栈不兼容，组件层归零

`apps/ui/package.json` 声明 `react-native` 0.81.5、`expo-router`、`react-native-unistyles`、
NativeWind，网页端靠 react-native-web 渲染。我们是 React DOM + Tailwind v4。
产品文件里对 RN 的依赖是硬依赖而非可选：`react-native-unistyles` 出现 50 次、`react-native` 46 次、
`expo-router` 6 次（均为 product-only 统计，已排除 `.test.*` / `.spec.*`）。
`StyleSheet.create((theme) => ({...}))` 这种写法（例：`shell/views/ToolInlineBody.tsx:389`）
既不是 CSS 也不是 Tailwind，逐文件重写是唯一路径。

### 重新数过的数字（与上轮口头结论有出入，以本节为准）

`apps/ui/sources/components/tools/` 下 `.ts` + `.tsx` 共 **249** 个，其中：

| 类别 | 数量 | 判据 |
|---|---|---|
| 测试 | **120** | 文件名含 `.test.` 或 `.spec.`（其中 3 个 `.spec.`，都在 `normalization/core/`） |
| 产品文件 | **129** | 其余 |

129 个产品文件再拆：

| 类别 | 数量 | 判据 | 对我们的意义 |
|---|---|---|---|
| RN 组件 | **51** | 直接 import `react-native` / `react-native-unistyles` / `nativewind` / `expo-*` | 必须重写 |
| 声明式工具目录 `catalog/**` | **27** | 目录归属；其中 **24 个一处 JSX 都没有** | 可移植，只需替掉 `icon` |
| 测试辅助 | **9** | 文件名含 `testHelpers` | 不搬 |
| 其余逻辑 | **42** | — | 其中 **36 个是纯 `.ts`，可直接移植** |

51 + 27 + 9 + 42 = 129。最后那 42 里有 6 个 `.tsx`（`renderers/core/_registry.tsx`、
`renderers/fileOps/DiffView.tsx`、`renderers/workflow/SubAgentView.tsx`、`TodoView.tsx`、
`shell/presentation/ToolHeaderActionsContext.tsx`、`buildToolHeaderModel.tsx`）——它们不 import
react-native，但确实渲染 JSX 或持有 React context，算 UI 耦合。**所以"要重写的 UI"实际是 51 + 6 = 57，
不是 51。**

**与本轮口头版本的差异**：口头说"117 个测试、约 120 个产品文件、约 21 个 catalog、约 55 个 RN 组件"。
实测是 120 / 129 / 27 / 51（或 57，取决于是否把那 6 个 `.tsx` 算进去）。
"约 36 个纯逻辑可直接移植"这一条核对得上。

### catalog 的 UI 耦合点比说的要宽一点

`catalog/_types.ts:1-20` 的 `KnownToolDefinition` 里，UI 耦合只有一个字段——但它不是
`icon: ReactNode`，而是**一个函数**：

```ts
icon: (size: number, color: string, opts?: { metadata: Metadata | null, tool: ToolCall }) => ReactNode;
```

其余字段（`title`、`noStatus`、`hideDefaultError`、`isMutable`、`input`/`result` 的 zod schema、
`minimal`、`extractDescription`、`extractSubtitle`、`extractStatus`）全是纯数据或纯函数。

27 个 catalog 产品文件里有 3 个真的写了 JSX：`catalog/icons.tsx`（图标库本身）、
`catalog/core/subAgent.tsx:13` 和 `catalog/core/subAgentRun.tsx:14`（两处都是同一行
`return agentId ? <AgentIcon agentId={agentId} size={size} /> : ICON_TASK(size, color)`）。
剩下 24 个零 JSX。**移植方式**：把 `icon` 的返回类型换成我们自己的图标句柄，其余整个目录原样抄。

### 外部依赖：不止 `@happier-dev/protocol`

product-only 统计，`components/tools/` 下的外部包共 3 个：

- `@happier-dev/protocol`（46 处 import，**60 个符号**）
- `@happier-dev/protocol/tools/v2`（9 处，6 个符号：`canonicalizeGenericSubAgentToolName`、
  `deriveCanonicalPatchFileDiffs`、`isChangeTitleToolNameAlias`、`isGenericSubAgentToolName`、
  `isSubAgentTranscriptToolName`、`normalizePatchInputRecord`）
- **`@happier-dev/agents`（3 处，漏说了）**：`renderers/workflow/AskUserQuestionView.tsx:23`、
  `catalog/core/subAgentPresentation.ts:1`、`shell/permissions/PermissionPromptCard.tsx:24`

根入口的 60 个符号里 **36 个是 `*V2Schema` zod schema**（其实都源自 `tools/v2`，只是从根导出），
约 9 个是类型，剩下十几个才是运行时函数（`maybeParseJson`、`extractShellCommand`、
`formatPermissionRequestSummary`、`getActionSpec`、`readRpcErrorCode`…）。
"只用到根入口的少数符号"这句**核对不上**：60 个不算少。但结论方向不变——其中绝大多数是
schema 和类型，不是需要移植的逻辑。

`maybeParseJson` 确实是个短纯函数，全文在 `packages/protocol/src/activity/parseJson.ts`（24 行）：
不是字符串就原样返回；只在 trim 后首字符是 `{` `[` `"` 时才尝试 `JSON.parse`；解析出来还是字符串的话
再尝试一层嵌套解析；任何失败都退回原值。**这个"只在看起来像 JSON 时才试，失败就退回原值"的形状
值得抄**，它把"解析"变成了一个永不抛异常的 lens。

整包大小："3.5 MB" 核对得上，但要说清是什么的 3.5 MB：`packages/protocol/src` 下 733 个 `.ts` 文件
源码文本合计 **3,587,592 字节**；`du -sh` 报 5.1 MB（含文件系统块开销）；排除测试后是 443 个文件、
2,079,384 字节。无论哪种算法，都远超 `components/tools/` 实际需要的那部分。

## 二、许可

| 事实 | 核对结果 |
|---|---|
| 仓库根 `LICENCE` 是 MIT | ✅ `MIT License / Copyright (c) 2026 Happy Coder Contributors` |
| `apps/ui/sources/components/tools/` 下无异种许可文件头 | ✅ 对 `Apache` / `Licen[cs]e` / `SPDX` / `Copyright` / `GPL` / `BSD` / `MPL` 做词边界扫描，**零命中** |
| Apache-2.0 只在 CLI 侧的两个文件 | ❌ **是三个** |

三个 Apache-2.0 文件（全仓库 `.ts`/`.tsx` 扫描结果）：

1. `apps/cli/src/agent/runtime/terminal/injection/arbiter.ts:1-2`
   `// Adapted from generalaction/emdash keystroke-injection patterns` / `// © 2026 General Action, Inc. Apache-2.0`
2. `apps/cli/src/agent/runtime/terminal/injection/bracketedPaste.ts:1-2`
   `// Adapted from generalaction/emdash src/shared/prompt-injection.ts` / 同上
3. **`apps/cli/src/integrations/tmux/index.ts:1-8`（新发现）**
   `TypeScript tmux utilities adapted from Python reference` / `Copyright 2025 Andrew Hundt <ATHundt@gmail.com>` /
   `Licensed under the Apache License, Version 2.0`

三处都在 CLI 侧，都不在我们这次要参考的 GUI 渲染路径上。

另有一处 MIT 第三方代码被内联进 UI：`apps/ui/sources/components/terminal/xterm/webview/xtermWebViewAssets.generated.ts:19`
把 xterm.js 的 CSS（含其 MIT 头）整段嵌进字符串常量。与本轮无关，记一笔以免日后误判。

**存疑（未解决）**：`apps/ui/sources/components/ui/markdown/editor/core/tiptap/listContinuation.ts:4`
注释写 `Ported from Orca's rich-markdown-list-continuation.ts`，**通篇没有任何许可声明**。
同样情况还有 `normalizeSoftBreaks.ts:24` 及两者的 `__tests__/` 对应文件。
要用其中任何一个，必须先单独查清 Orca 是什么项目、什么许可。本轮没查。

## 三、设计要点（这才是我们要照抄的）

### 1. 渲染器注册表：一张表 + 三条归一化 + 一个兜底

`apps/ui/sources/components/tools/renderers/core/_registry.tsx`：

- `toolViewRegistry`（:54-88）类型是 `Record<KnownCanonicalToolNameV2, ToolViewComponent>`——
  **穷举类型**，协议里新增一个规范工具名而没写渲染器，编译就红。我们的 `RENDERERS` 是数组 + `find`，
  没有这个保护；要不要加值得单独想。
- `getToolViewComponent(toolName)`（:91-97）三步：
  1. `toolName.startsWith('mcp__')` → `MCPToolView`（前缀规则先于一切）
  2. `normalizeToolNameForView(toolName)` 归一
  3. `KnownCanonicalToolNameV2Schema.safeParse` 校验 → 失败或查不到 → `UnknownToolView`
- 一张表里允许多名指向同一视图：`TodoWrite`/`TodoRead` → `TodoView`，`Task`/`SubAgent` → `SubAgentView`，
  三个 `AgentTeam*` → `AgentTeamView`。

`normalization/policy/normalizeToolNameForView.ts:36-42` 的归一化顺序也是有意的：
`mcp__` 前缀**原样返回不归一**（:37）→ change_title 别名 → 通用 subagent 名 → 最后才查
`legacyToolNameToCanonical` 静态表（:3-34）。静态表里的注释值得一读（:14-19）：
`task_output`/`task_stop` 的 snake_case 拼法**刻意与 CLI 侧 `canonicalizeToolNameV2` 对齐**，
理由写得很直白——"两个归一化器不能对同一个工具给出不同答案"。
我们在 `frontend/src/features/conversations/tools/identify.ts` 抄的就是这张表。

### 2. 渲染器不处理异常，异常全在外壳

这是本轮最值得照做的一条。`shell/views/ToolInlineBody.tsx` 的判定链（源码顺序）：

| 顺序 | 行 | 条件 | 产出 |
|---|---|---|---|
| 1 | :244-258 | `resolveToolPermissionTerminalErrorMessage` 返回非空（权限被拒/取消的终态） | 只渲染 `<ToolError>`，**直接 return**，专用渲染器根本不上场 |
| 2 | :261-289 | `getToolViewComponent` 拿到组件 | 渲染专用视图；**再在它后面追加** `tool.state === 'error' && tool.result && !hideDefaultError` 的 `<ToolError>` |
| 3 | :292-306 | `minimal` | `StructuredResultView` 或 null |
| 4 | :309-333 | `tool.state === 'error'` 且非 tool-use error | `<ToolError>`（SubAgentRun 类走 `StructuredResultView` 兜底） |
| 5 | :336-353 | `mode === 'timeline' && detailLevel === 'summary'` | 只画 INPUT 代码块 |
| 6 | :355-386 | 默认 | INPUT + （running 时的 `StructuredResultView`）+ OUTPUT 代码块 |

**要抄的是第 1 和第 2 步的关系**：权限终态在渲染器**之前**被截掉；而"工具失败了"的错误条在渲染器
**之后**被追加。两头都在外壳，中间的渲染器可以假装只有成功路径，`hideDefaultError`（来自
catalog 定义）是渲染器唯一能表达"这个错误我自己画"的开关。

**注意：第 3-6 步在当前提交下不可达**，详见"存疑与上游缺陷"。

外壳还把 payload 预览做成了带预算的流式序列化（:59-110 `buildBoundedJsonPreview`）：
不是先 `JSON.stringify` 再 `slice`，而是边写边记账，超预算立刻停（`appendBounded` :44-57），
带 `WeakSet` 循环检测（:78-82），截断后给一个"显示完整"按钮（:150-168）。
预算来自设置 `filesDiffTokenizationMaxBytes`，fallback 250,000（:34-42）。

### 3. "completed 也可能是失败"

`shell/presentation/resolveToolStatusIndicatorKind.ts:80-93` 的优先级：

```
permission denied/canceled  → permission_blocked
permission pending + running → permission_pending
state === 'running'          → running
state === 'error'            → error
state === 'unavailable'      → hasToolResultFailure ? error : none
state === 'completed'        → hasToolResultFailure ? error : completed   ← 关键
```

`hasStructuredResultFailure`（:33-65）是一个**深度不超过 5 层的递归挖掘**：

- 命中条件只有两个：`record.ok === false` 或 `record.isError === true`（:42）
- 递归入口：`results[]` 数组每一项（:44-48）、固定四个键 `data` / `output` / `result` / `stdout`（:50-52）、
  `content` 字符串、以及 `content[]` 里 `type === 'text'` 的块的 `.text`（:54-62）
- 字符串会被尝试解析成 JSON，**但只在解析出的东西是 `{v: 1, kind: 'tools_call'}` 信封时才继续下钻**
  （:35-37 + `isHappierToolsCallEnvelope` :27-31）——这是防止把任意 JSON 字符串当成工具结果乱挖的闸门
- `parseStructuredResultText`（:11-25）有个小技巧：整段解析失败时，退而解析**第一行**——
  应付"一行 JSON + 后面跟着人类可读文本"这种混合输出

另有一条特判在 `hasToolResultFailure`（:67-78）：`result.tool_use_result` 是字符串且以 `error:`
开头（大小写不敏感）就算失败。

### 4. 错误摘要的取值顺序

`shell/presentation/resolveToolErrorSummary.ts:19-53`，结果是对象时按这个顺序取第一个非空的：

1. `tool_use_result` 且匹配 `/^error:/i` → 剥掉 `error:` 前缀，取首行
2. `error`（字符串）→ 首行
3. `error.message`（对象）→ 首行
4. `message` → 首行
5. `content`（字符串）→ 首行

结果是字符串时（:47-51）：取首行，若匹配 `/^error:/i` 则剥前缀。
全都取**首行**（`firstLine` :8-13）——摘要位只有一行，多行栈追踪留给正文。

### 5. 详情级别是四档，不是三档——而且两份定义在打架

- `normalization/policy/resolveToolViewDetailLevel.ts:1`：`'title' | 'compact' | 'summary' | 'full'`（**四档**）
- `renderers/core/_registry.tsx:38`：`'title' | 'summary' | 'full'`（**三档**，少了 `compact`）

两个同名类型 `ToolViewDetailLevel` 在两个文件里不一致。四档是实际在用的那份：
`shell/views/ToolView.tsx:332` 的 `isBodyVisible = effectiveDetailLevel !== 'title' && !== 'compact'`
明确说明**前两档不渲染卡片体**；`ToolInlineBody` 的 prop 类型也因此收窄成 `'summary' | 'full'`
（`ToolInlineBody.tsx:182`）。同样的两档判定重复出现在
`shell/permissions/PermissionPromptCard.tsx:93` 和 `ToolView.tsx:260`。

`compact` 还带一个副作用：`normalization/policy/deriveToolTimelineDensity.ts:7-8`——
`title` 和 `compact` 一起把时间线密度压成 `compact`、图标缩到 16px。
默认值由 chrome 模式决定：`resolveToolViewDetailDefaultsForChromeMode.ts:14`，
`activity_feed` 模式默认 `compact`，其余默认 `summary`。

`resolveToolViewDetailLevel` 本身的优先级（:10-20）：
按工具名的显式覆盖 → 从 `toolInput._happier.sessionMode`（或 legacy `_happy.sessionMode`）
读出的 `local_control` 走单独的默认值 → 全局默认。**注意它是从工具入参里读会话模式的**，
这种"把上下文塞进 payload 的元字段"我们没有对应物。

### 6. schema 是镜头不是闸门

`packages/protocol/src/tools/v2/schemas.ts`，529 行，53 个导出 schema。核对结果：

- `BaseEnvelopeSchema`（:6-11）自身就是 `z.object({_happier?, _happy?, _raw?}).passthrough()`
- 53 个导出里 **51 个**是 `BaseEnvelopeSchema.extend({...}).passthrough()`；
  另外 2 个是纯别名赋值（`SubAgentInputV2Schema = TaskInputV2Schema`、`SubAgentResultV2Schema = TaskResultV2Schema`），
  不是例外
- 全文 72 处 `.passthrough()`——嵌套对象也 passthrough（例 `:75-80` MultiEdit 的 `edits[]` 元素）
- 顶层字段**全部 optional**：逐行扫描没有找到一个必填的顶层字段。
  嵌套对象要么 `.partial().optional()`（例 `ReadResultV2Schema.file` :42-48），
  要么 `.passthrough().optional()`（例 `:324`、`:331`、`:335`）
- `_raw` 只在 `BaseEnvelopeSchema:10` 定义一次，`z.unknown().optional()`，被所有 schema 继承

**这一套的意思**：schema 不拒绝任何东西。它只做两件事——给已知字段一个名字和类型，
给未知字段一条原样通过的路。字段全 optional 意味着"某个 provider 没给这个字段"永远不是错误。

值得单看的一条注释在 `BashInputV2Schema`（:17-23）：`run_in_background` 被标注为
"这只是一个*请求*，只有结果里的 `backgroundTaskId` 才能证明 provider 真的把它挂后台了，
渲染器不得把这个 flag 当作证据"。**入参里的意图和结果里的事实要分开对待**——
这条比 schema 本身更值钱。

`BashResultV2Schema`（:25-32）是 `stdout` / `stderr` / `exit_code` / `backgroundTaskId` / `errorMessage`，
全 optional。这正是我们 shell 结果缺的那个形状。

### 7. 生产侧归一化：把"completed 其实失败了"提前判掉

`apps/cli/src/agent/tools/normalization/`，34 个 `.ts`（含测试），主体是 29KB 的 `index.ts`
加 `families/` 下按工具家族切分的 14 个模块：
`execute` / `read` / `edit` / `multiEdit` / `write` / `patch` / `diff` / `search` / `todo` / `web` /
`task` / `delete` / `reasoning` / `changeTitle` / `mcp`。

`withCommonErrorMessage`（`index.ts:47-81`）的逻辑值得逐条看：

- 已有非空 `errorMessage` 就不动（:48-49）
- 候选取值顺序：`error` → `stderr` → `message` → `text`（:51-57）
- "是否失败"的判据是**五个 or**（:65-71）：
  `isError === true` / `ok === false` / `success === false` / `applied === false` /
  `exit_code`（或 `exitCode`）是有限数且 ≠ 0
- **关键的一条**（:73-75）：`message` 和 `text` 这两个候选，**只在已判定失败时才被提升成
  `errorMessage`**。因为成功的结果里也有 `message`，不加这道闸门就会把成功结果标成错误。

调用点在 `index.ts:666`：`mergeHappierMeta(withCommonErrorMessage(normalized), meta)`，
紧接着 `:667` 挂上 `_raw: truncateDeep(opts.rawOutput)`。
`_raw` 一共出现在 9 个分支（`index.ts:322`、`335`、`348`、`361`、`374`、`387`、`400`、`413`、`667`），
**每条归一化路径都保留一份截断后的原始输出**。

### 8. `truncateDeep`——本轮直接采纳的那条

`apps/cli/src/agent/tools/redaction/redact.ts:3-34`，32 行，无依赖。默认上限
`maxString: 2000` / `maxArray: 50` / `maxObjectKeys: 200` / `maxDepth: 6`（:8-11）。

四条规则：

- 超深度 → 返回字符串 `'[truncated depth]'`（:13）
- 长字符串 → `前 maxString 字符 + '…(truncated N chars)'`（:15-18）
- 长数组 → 前 `maxArray` 项（每项继续递归）+ 末尾追加一个 `'…(truncated N items)'` **字符串元素**（:22-26）
- 宽对象 → 前 `maxObjectKeys` 个键 + 一个 `_truncatedKeys: N` 数字字段（:28-33）

**为什么这是对的**：三种超限各自用了最不破坏形状的记号——数组多加一项、对象多加一个键、
字符串接一段尾巴。读的人永远知道自己看的是截断后的值，也永远知道少了多少。
对比之下，"整个参数对象压成一个标量"丢的不只是内容，是形状。

注意仓库里另有两份**同名但不同的**拷贝：`agent/tools/trace/extractToolTraceFixtures.ts:60`
和 `curateToolTraceFixtures.ts:52`，都是 local function、都没有 `maxDepth`。
上游自己就漂移了三份——如果我们抄，抄 `redact.ts` 那份，并且只留一份。

## 四、存疑与上游缺陷

### 1. `ToolInlineBody` 近百行兜底逻辑不可达（已确认，非存疑）

`getToolViewComponent` 的返回类型写的是 `ToolViewComponent | null`（`_registry.tsx:91`），
但函数体三条 return 路径没有一条能返回 null：

- `:92` mcp 前缀 → `MCPToolView`
- `:95` schema 校验失败 → `UnknownToolView`
- `:96` `toolViewRegistry[parsed.data] ?? UnknownToolView`

于是 `ToolInlineBody.tsx:262` 的 `if (SpecificToolView)` **恒为真**，
第 291-386 行（`minimal` 分支、error 分支、timeline summary 分支、默认 INPUT/OUTPUT 分支）
全部不可达。同理 `shell/presentation/buildToolHeaderModel.tsx:50` 的
`hasSpecificView = !!getToolViewComponent(...)` 恒为 true，导致 `:51-54` 的
`isUnknownTool` **恒为 false**——"未知工具默认折叠"（`:66`）和"未知工具隐藏卡片体"（`:65`）
这两个特性在当前提交下是死的。

功能上没崩，是因为 `UnknownToolView`（`renderers/system/UnknownToolView.tsx:54-99`）
把兜底责任自己接了过去：`title` 档返回 null（:55）、`summary` 档画一行
`key=value` 摘要 + 截到 800 字符的结果文本（:60-73）、`full` 档画 INPUT/OUTPUT 两段
（:86-95）。所以**能力还在，只是从外壳搬进了兜底渲染器，而外壳里的旧路径没删**。

浅克隆没有历史，无法判断这是重构未清理还是别的。

**对我们的意义**：这正是"注册表兜底"最容易踩的坑——一旦兜底从"返回 null 让外壳处理"
变成"返回一个万能组件"，外壳里所有 `if (renderer)` 的 else 分支就悄悄死了，
而且不会有任何编译或测试报警。我们的 `registry.tsx:63`
`RENDERERS.find(r => r.match(input))` 返回的是真 `undefined`，兜底
`SummaryRow` 是外壳显式选的，目前形状是对的——**要守住这一点**。

### 2. 两份 `ToolViewDetailLevel` 类型不一致

见"设计要点 5"。三档那份（`_registry.tsx:38`）少了 `compact`，而渲染器的
`ToolViewProps.detailLevel`（`:46`）用的正是这份三档类型。实际传进去的值可能是
`'summary' | 'full'`（外壳已收窄），所以暂时没爆。仍是隐患。

### 3. Orca 许可未知

见"许可"节末尾。`listContinuation.ts` / `normalizeSoftBreaks.ts` 及其测试要用得单独查。

### 4. 本轮完全没有验证的部分

- 没跑 Happier 的任何测试（上一轮曾用 Node TS stripping 直接验过 `arbiter.ts` 的纯函数，
  这一轮没做等价的事）。
- `hasStructuredResultFailure` 的递归键列表（`data`/`output`/`result`/`stdout`）是不是覆盖了
  真实 provider 的形状，只看了代码没看 fixture。`normalization/__fixtures__/` 下有
  `fixtures.v1.*.test.ts` 三套，没读。
- 没有在浏览器里跑过 `apps/ui` 的 web 构建，"靠 react-native-web 渲染网页"这一条
  **是从依赖声明推出来的，没有本机复现**。

## 五、对我们的结论

### 已经落地（提交 `6a5006b`）

`frontend/src/features/conversations/tools/`：`identify.ts`（纯函数归一 + 参数解析）、
`registry.tsx`（注册表 + `ToolView` 分派入口）、`SummaryRow` / `PatchTool` / `BashTool` / `McpTool`。
搬的是设计不是代码；唯一逐字借的是历史工具名对照表，出处已注在 `identify.ts` 里。

对照本轮调研，我们比 happier 做对的两处：

1. **兜底由外壳显式选择**，不是塞进注册表当万能渲染器——见"存疑"第 1 条，这是他们踩了的坑。
2. **`patch` 按数据认领不按名字**（`registry.tsx:42` `match: ({ block }) => !!block.patch?.hunks.length`）。
   happier 全部按名字走注册表，代价是没列进表的工具带着真实 diff 过来就静静消失。

还没对齐的一处：他们的注册表是 `Record<KnownCanonicalToolNameV2, ...>` **穷举类型**，
新增协议工具名而漏写渲染器会编译失败；我们是数组 + `find`，漏了不会报警。

### 正在做

把 `packages/ai-transcript/` 的参数预览从"压成一个标量"改成结构化深度截断
（`packages/ai-transcript/src/truncate.ts`，思路取自 `redact.ts` 的 `truncateDeep`，
上限按预览场景收紧成 300/20/40/4，实现是我们自己的）。

这条直接解掉 `registry.tsx:19` 注释里记的那个约束——"数据不够就不认领"。
Grep 的 pattern、TodoWrite 的 todos 原来在写库那一刻就没了，截断改完之后它们能活下来。

### 还没做

1. **shell 结果结构化**。`BashTool.tsx:17` 自己记着："拿不到 stdout / stderr / 退出码——
   我们的 result 是拍平的一坨字符串，后端没有分流。"
   目标形状照 `BashResultV2Schema`（`schemas.ts:25-32`）：
   `stdout` / `stderr` / `exit_code` / `errorMessage` 全 optional + passthrough + `_raw`。
   配套的是 `withCommonErrorMessage`（`normalization/index.ts:47-81`）那套"exit_code ≠ 0 即失败"
   的生产侧判定——**要在解析器里做，不在渲染器里做**。
2. **Grep / Glob / Todo 渲染器**。卡在数据上不是人手上：这三个的参数在预览态里根本没存下来。
   等上面"正在做"的截断落地后自然解锁。
3. **grok 把标题写进 `name` 的 bug**。`packages/ai-transcript/src/grok.ts:58`：

   ```ts
   const extra = {toolCallId:update.toolCallId, ...(typeof update.title === 'string' ? {name:update.title.slice(0,512)} : {})};
   ```

   `update.title` 是给人看的标题，被写进了工具名字段。于是 grok 的工具调用永远匹配不到
   任何渲染器（`identifyTool` 拿到的是一句话不是工具名），而且兜底显示的"工具名"其实是标题。
   修之前要先确认 grok 的记录里有没有别的字段真的带工具名。

### 下一轮如果继续

优先级从高到低：

1. **`hasStructuredResultFailure` 的键列表值不值得抄**——需要拿我们自己的真实结果数据对一遍，
   而不是照搬他们的四个键。
2. **catalog 那 24 个零 JSX 文件到底能省多少事**——它把"这个工具叫什么、用什么图标、
   要不要显示状态、错误自己画不画"从渲染器里抽出来变成数据。我们现在这四件事散在各渲染器里。
3. **穷举型注册表**要不要在我们这边做——取决于我们有没有一份"规范工具名"的封闭集合。
   目前没有。
