/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE 三处，都标在原位：

  1. **入口从他们的 `ToolCallBlock` 换成平的 `ToolCallFacts`。** 上游那个类型是 ui-chat
     的 fold 产物（`'kind' in block` 判已结算、`block.error?.code` 判中断、`block.call.argsRaw`
     取参数），连着他们一整套快照缓存；我们没有。四态的**判定规则**一个字没改，改的只是
     它从哪三个布尔上读。
  2. `resultText()` / `deriveAutoReviewDenial()` 没搬。前者是把他们的 content block 数组拍平，
     我们的解析器早就给的是拍平文本（`ToolBlock.result`）；后者认的是他们 Auto-review 的
     结构化错误对象，我们没有那个功能，而且 `ToolRow` 压根不读这个字段。
  3. 路径缩写（`relativizeToCwd` / `abbreviateHomePath`）来自他们的 util-workspace-path 包，
     这次不搬——换成可选的 `shortenPath` 钩子，不传就是原样。这样「摘要里的路径要不要
     相对化」留在调用方，而不是把一个 Node 味道的路径库拖进前端。

  除此之外逐字：变体表、摘要取键顺序、`formatToolBody`、空串语义全部原样。
*/

/** Tool-call row variants selected by the generic atomic renderer. */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** Row state semantic; colors self-supplied via StateDot (design gives none). */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

/**
 * ROOST-CHANGE：上游 `toolRowModel` 收的是 `ToolCallBlock`（running 分支 / settled 分支
 * 的联合），这里换成一次调用的**平事实**。三个布尔就是上游那三个分支判据：
 *
 * | 上游 | 这里 |
 * | --- | --- |
 * | `'kind' in block` | `settled` |
 * | `block.error?.code === 'interrupted'` | `interrupted` |
 * | `block.isError` | `isError` |
 *
 * 这么拆是因为「跑完了但失败」和「压根没跑」在我们的解析器里本来就是两个字段
 * （`failed` / `denied`），合进一个错误对象再判一次只会多一层转译。
 */
export interface ToolCallFacts {
  /** Wire tool name（可能是空串：孤儿结果没有名字）。 */
  toolName: string
  /** 调用参数原文（JSON，或流式截断的半截文本）。空串 = 没有参数。 */
  argsRaw: string
  /** 参数是空串时顶替摘要的调用 id。 */
  callId: string
  /** 结算文本；`null` = 还没结算，或者结算了但一个字都没有。 */
  result: string | null
  /** 已经结算（跑完了，不管成功失败）。 */
  settled: boolean
  /** 这次调用被打断/拒绝了——命令没跑完，也不是一次故障。 */
  interrupted: boolean
  /** 结算成失败。 */
  isError: boolean
}

/** ROOST-CHANGE：路径缩写钩子，见文件头第 3 条。 */
export interface ToolRowModelOptions {
  /**
   * 摘要里那一段（通常是路径）要怎么缩。不传就是原样——上游这里固定串
   * `relativizeToCwd` + `abbreviateHomePath` 两个函数，那两个在他们的 util 包里。
   */
  shortenPath?: ((value: string) => string) | undefined
}

/**
 * Known tool name -> variant.
 *
 * ROOST-CHANGE：逐字留着，包括 `cordis_*` 那几行——它们在我们这儿永远匹配不到，但删掉
 * 就等于改了这张表，将来重新同步要做三方合并。代价是几行死数据。
 *
 * **注意大小写。** 这张表是他们的 wire 名（全小写），Claude 的 transcript 里是 `Bash` /
 * `Read` / `Grep`。调用方要么先 `toLowerCase()`，要么自己分类后把 variant 直接传给
 * `ToolRow`——`classifyTool` 不是必经之路。
 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  // The PowerShell twin is a shell tool: the bash row family (icon, colors)
  // with its own title from TOOL_TITLE_KEYS, not the generic `others` row.
  pwsh: 'bash',
  read: 'read',
  // read_image is a single-file read: the same browse icon and the same openable
  // path summary (FILE_PATH_VARIANTS covers `read`), with its own title key below.
  // Left unclassified it falls to `others`, which titles the row generically and
  // derives no filePath — so the path the row advertises as openable never is.
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  // The three run-control verbs take one package id and produce a receipt, so
  // the generic row is the decided intent, not an unclassified default: there is
  // no program to show (that is `cordis_define`'s card) and no file to open. The
  // id lands in the summary slot, and the titles below name the act.
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, others when unknown.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/**
 * Everything ToolRow needs, derived once from the frozen slice.
 *
 * ROOST-CHANGE：上游还有 `titleKey`（他们的 i18n 键）和 `autoReviewDenial` 两个字段。
 * 标题这次由调用方直接给字符串（`ToolRow` 的 `title` prop），所以模型不再产键；
 * denial 的理由见文件头第 2 条。
 */
export interface ToolRowModel {
  variant: ToolRowVariant
  summary: string
  /**
   * Filesystem path from args (`path` / `file_path`) when the row is a file
   * tool; absent for URL reads and non-file tools. The chat view resolves
   * relative values against the session cwd before opening.
   */
  filePath: string | undefined
  /** Original argument JSON retained for expansion-time body formatting. */
  bodyRaw: string | null
  /** Flattened result text; null while running or when the result carries no text. */
  output: string | null
  /** First line of the result text on an error row; null for every other state. */
  errorSummary: string | null
  state: ToolRowState
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): summary/body fall back to the raw string.
    return undefined
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

function deriveSummary(variant: ToolRowVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return firstLine(argsRaw)
}

/** Path keys only — never `url` (web_fetch lands on the read variant). */
const FILE_PATH_KEYS = ['path', 'file_path'] as const

/** File-tool variants whose summary may be an openable workspace path. */
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit'])

function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const picked = pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS)
  return picked === undefined ? undefined : firstLine(picked)
}

/**
 * Format one argument payload when its generic input body becomes visible.
 * @param variant - row presentation selected for the Tool name.
 * @param argsRaw - original argument JSON or incomplete raw text.
 * @returns display body, or null for empty input.
 */
export function formatToolBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  // The code row's expanded body IS the program (monospace via the row's
  // variant styling), not the args JSON envelope around it.
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = (parsed as Record<string, unknown>).code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/**
 * Derive the full row model from one call's flat facts.
 * @param facts - 这次调用的平事实，见 {@link ToolCallFacts}。
 * @param options - 路径缩写钩子（ROOST-CHANGE，见文件头第 3 条）。
 * @returns the row model.
 */
export function toolRowModel(facts: ToolCallFacts, options: ToolRowModelOptions = {}): ToolRowModel {
  const { toolName, argsRaw, callId, result, settled, interrupted, isError } = facts
  const variant = classifyTool(toolName)
  /*
    四态的判定顺序照抄上游，而这个顺序本身是有意义的：**没结算优先于一切**（还在跑的
    调用不可能已经失败），**中断优先于失败**——一次「我不让它跑」不是一次故障，两者
    合并会在对话里报告一个没发生过的错误。
  */
  const state: ToolRowState = !settled ? 'running'
    : interrupted ? 'stopped'
      : isError ? 'error' : 'ok'
  const shorten = options.shortenPath ?? ((value: string) => value)
  const base = argsRaw === '' ? callId : shorten(deriveSummary(variant, argsRaw))
  // Others keeps the static "Tool call" title (figma literal); the real tool
  // name rides the mutable summary slot unless the tool owns a specific title.
  // ROOST-CHANGE：上游这里还有一个 `&& toolTitleKey === undefined`（自带标题的工具不再
  // 把名字塞进摘要）。标题键这次没搬（文件头第 2 条），而带标题键又落在 others 上的只有
  // 三个 `cordis_*`，在我们这儿本来就匹配不到——所以这一项一起去掉，而不是留个永远为真的条件。
  const summary = variant === 'others' && toolName !== '' ? `${toolName} · ${base}` : base
  // The empty string is "no text" for both derived result fields: a settled
  // call with blank content has nothing to expand, and a blank first line
  // would erase the collapsed error row's summary slot.
  const output = settled ? (result || null) : null
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null
  const bodyRaw = argsRaw === '' ? null : argsRaw
  return { variant, summary, filePath: deriveFilePath(variant, argsRaw), bodyRaw, output, errorSummary, state }
}
