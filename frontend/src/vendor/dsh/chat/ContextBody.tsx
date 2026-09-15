/*
  改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-chat/src/client/chat/ContextBody.tsx
  —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。

  **渲染结构（元素、顺序、className、data-* 属性）一行未动**，七个函数体（`contentRuns` /
  `boundedText` / `fieldValue` / 四个 `*Changes|Entries|Sections|Sessions` 读取器）除下面
  点名的两处外也一行未动。ROOST-CHANGE 逐条：

  1. **`t(key, params)` 换成平的 `labels` 对象。** 上游那个 `t` 是 ChatView 插槽运行时递下来的
     locale seat（`ChatViewSlotProps['t']`），我们没有那套运行时；而复数和数字格式在我们的
     i18n 里是另一套写法。所以让调用方把文案拼好传进来，这个目录不必认识任何字典。
     同 `MessageItem.tsx` / `CompactionItem.tsx` 的做法（`StatsPills.tsx` 那种保留 `t` 形状的
     写法是另一条路，那边是因为文案多到列成对象更难读）。
     `instructionAction` 因此从「返回 locale key」变成「返回 `labels.instructions` 的字段名」，
     四档的分支条件一字未改。

  2. **`KnownContextForm` 本地声明，不从上游 contract import。** 上游是
     `@deepseek-ai/dsh-client-ui-conversation/client` 里的一个字面量联合，为一个联合搬整份
     contract 不划算——同 `StatsPills.tsx` 的 `SessionTokenUsage`、`TurnUsagePanel.tsx` 的先例。
     **六档一个不少**：`contextBody` 那个 switch 的 `default` 分支靠 `never` 兜底，少一档就是
     让编译器闭嘴，将来对上了也不会有人发现。

  3. **`content` 的元素类型。** 上游是 `@deepseek-ai/dsh-llm/types` 的 `ContentBlock`——一个
     merge-extensible 的联合（十几档，我们一档都不产出）。这里收窄成「文本块 + 其它任意块」
     两档：这个文件本来也只区分这两档（`block.type !== 'text'`）。判定改成类型守卫
     `isTextBlock`，因为「其它」那一档的 `type` 是 `string` 而不是字面量，`!==` 收窄不掉它，
     而类型守卫两个分支都能收窄。**判定的内容仍旧是 `block.type === 'text'`。**

  4. `source` 保持 `unknown`，**一个字没动**——上游这一侧本来就是 `unknown`，所有读取都走
     `asRecord` 的全有或全无闸门。这是这份文件最值钱的性质：喂不出某一档的数据时它自己退回
     `OpaqueBody`，而不是画一个有标题没内容的空壳。所以 `relay` / `recall` 这两档**我们的
     transcript 里根本没有对应物**，代码照样留着——它们不是「言之凿凿的空壳」那一类
     （对比 NOTICE「没搬什么」里点名的 `TurnMaxTokensRow`：那个只吃文案，接上就一定出现）。

  5. **删掉 `SourceFields` 之外的东西一个没有**：这份文件没有依赖上游运行时的部分，
     所以除上面四条之外是逐字的。
*/
import type { ReactNode } from 'react'
import { JsonBlock } from '../markdown/JsonBlock.tsx'
import css from './ContextBody.module.css'

/** Model-facing text stays bounded at the disclosure, not at the producer. */
const MAX_CHARS = 20_000

/** Rows a list body materializes before summarizing the remainder. */
const MAX_ENTRIES = 200

/**
 * ROOST-CHANGE 2：上游从 `ui-conversation` 的 contract import 这个联合。
 *
 * One durable context form this UI version knows how to present. Target
 * projections map absent or unknown forms to their opaque presentation so
 * logs written by older, newer, or foreign producers remain visible.
 */
export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

/** ROOST-CHANGE 3：上游 `TextBlock`（`@deepseek-ai/dsh-llm/types`）同形。 */
export interface ContextTextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * ROOST-CHANGE 3：上游 `ContentBlock` 联合收窄成两档。
 *
 * 「其它」那一档只要求有 `type`，其余字段原样交给 `JsonBlock` —— 上游那个联合是
 * merge-extensible 的，这个文件从头到尾也只问「是不是 text」。
 */
export type ContextContentBlock = ContextTextBlock | { readonly type: string; readonly [key: string]: unknown }

/** ROOST-CHANGE 3：`type` 是 `string` 的那一档 `!==` 收窄不掉，所以走类型守卫。 */
function isTextBlock(block: ContextContentBlock): block is ContextTextBlock {
  return block.type === 'text'
}

/** ROOST-CHANGE 1：`OpaqueBody` 这条最小路径要的两句文案（上游 `t` 的两个 key）。 */
export interface OpaqueBodyLabels {
  /** 这一版 UI 不认识的内容块，JsonBlock 的标题（上游 `message.unknownBlock`）。 */
  unknownBlock: string
  /** 正文超过 20000 字符时压在末尾的那一行（上游 `json.truncated`）。 */
  jsonTruncated: (total: number) => string
}

/** instructions 一档的四个动作词（上游 `message.context.instructions.*`）。 */
export interface InstructionActionLabels {
  /** baseline 那一次：这份文件是随会话开场载入的（上游 `…loaded`）。 */
  loaded: string
  /** 增量里新对上的一份（上游 `…added`）。 */
  added: string
  /** 增量里被重写的一份（上游 `…updated`）。 */
  updated: string
  /** 不再生效的一份（上游 `…removed`）。 */
  removed: string
}

/** ROOST-CHANGE 1：七种正文用到的全部文案，换掉上游的 locale seat。 */
export interface ContextBodyLabels extends OpaqueBodyLabels {
  instructions: InstructionActionLabels
  /** 这一份目录整个替换掉先前那份（上游 `message.context.catalog.replaced`）。 */
  catalogReplaced: string
  /** 超过 200 条时的省略脚注（上游 `message.context.catalog.more`）。 */
  catalogMore: (count: number) => string
  /** 快照取代先前快照的那句说明（上游 `message.context.snapshot.supersedes`）。 */
  snapshotSupersedes: string
  /** 转发来自哪个会话（上游 `message.context.relay.from`）。 */
  relayFrom: (session: string) => string
  /** 召回了多少条、省略了多少条（上游 `message.context.recall.counts`）。 */
  recallCounts: (retained: number, omitted: number) => string
  /** 这一路召回被截断过（上游 `message.context.recall.truncated`）。 */
  recallTruncated: string
}

/** ROOST-CHANGE 1：每个正文组件的公共入参，上游是 `{ content, source, t }`。 */
export interface ContextBodyProps {
  content: readonly ContextContentBlock[]
  source: unknown
  labels: ContextBodyLabels
}

/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** One run of the model-facing content: adjacent text, or one unknown block. */
type ContentRun = { text: string } | { block: unknown }

/**
 * The content blocks as runs, IN THE ORDER the model received them.
 *
 * Adjacent text blocks join with no separator, matching how provider adapters
 * flatten them — inserting a line break would show the reader a line the model
 * never saw. An unknown block breaks the run and keeps its own fallback rather
 * than being hoisted past the text around it or vanishing; the block union is
 * merge-extensible, so a foreign log may interleave shapes this build does not
 * know.
 */
function contentRuns(content: readonly ContextContentBlock[]): ContentRun[] {
  const runs: ContentRun[] = []
  for (const block of content) {
    if (!isTextBlock(block)) {
      runs.push({ block })
      continue
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && 'text' in last) last.text += block.text
    else runs.push({ text: block.text })
  }
  return runs
}

/** Only the blocks this UI version does not know, for bodies that replace the text. */
function unknownBlocks(content: readonly ContextContentBlock[]): unknown[] {
  return contentRuns(content).flatMap(run => 'block' in run ? [run.block] : [])
}

/** The model-facing text, truncated to the display bound. */
function boundedText(text: string, labels: OpaqueBodyLabels): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${labels.jsonTruncated(text.length)}`
    : text
}

/**
 * One source field rendered as a value row; nested shapes stay compact JSON.
 * Bounded on its own, because source fields are as unbounded as the text: an unknown
 * producer may record an arbitrarily large string or array.
 */
function fieldValue(value: unknown, labels: OpaqueBodyLabels): string {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  return boundedText(text, labels)
}

/**
 * Source fields as a key/value list. `kind` is always omitted because the
 * row header already names the producer. `form` is omitted only when a
 * dedicated body rendered for it — then the presentation the reader is looking
 * at IS that value. On the opaque fallback the declaration is kept, because
 * that is the one place a form this version cannot present would otherwise
 * disappear from the UI entirely.
 */
function SourceFields({ source, formRendered, labels }: {
  source: unknown
  formRendered: boolean
  labels: OpaqueBodyLabels
}): ReactNode {
  const record = asRecord(source)
  if (record === null) return null
  const hidden = formRendered ? ['kind', 'form'] : ['kind']
  const rows = Object.entries(record).filter(([key]) => !hidden.includes(key))
  if (rows.length === 0) return null
  return (
    <dl className={css.fields} data-context-fields>
      {rows.map(([key, value]) => (
        <div key={key} className={css.field}>
          <dt className={css.fieldKey}>{key}</dt>
          <dd className={css.fieldValue}>{fieldValue(value, labels)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Content blocks this UI version does not know, kept visible rather than
 * dropped: the block union is merge-extensible, so a newer or foreign log may
 * carry a shape this build has no presentation for.
 * @param props - The unrecognized blocks and the labels.
 * @returns One generic JSON block per unknown entry.
 */
function UnknownBlocks({ blocks, labels }: { blocks: readonly unknown[]; labels: OpaqueBodyLabels }): ReactNode {
  return (
    <>
      {blocks.map((block, index) => (
        <JsonBlock
          key={index}
          label={labels.unknownBlock}
          payload={block}
          truncatedLabel={total => labels.jsonTruncated(total)}
        />
      ))}
    </>
  )
}

/**
 * The model-facing content of one context, shared by every form that shows it:
 * the text with its real line breaks, then any block this UI version does not
 * know, which keeps its own fallback rather than vanishing.
 * @param props - Durable content and the labels.
 * @returns The content blocks as the model received them.
 */
function ModelFacingContent({ content, labels }: {
  content: readonly ContextContentBlock[]
  labels: OpaqueBodyLabels
}): ReactNode {
  return (
    <>
      {contentRuns(content).map((run, index) => ('text' in run
        ? run.text !== '' && (
          <pre key={index} className={css.text} data-context-text>{boundedText(run.text, labels)}</pre>
        )
        : (
          <JsonBlock
            key={index}
            label={labels.unknownBlock}
            payload={run.block}
            truncatedLabel={total => labels.jsonTruncated(total)}
          />
        )))}
    </>
  )
}

/**
 * Default presentation: the model-facing text as text, with its real line
 * breaks, and the remaining source fields beneath it. This is what every form
 * this UI version does not recognize renders as.
 * @param props - Durable content, its source, and the labels.
 * @returns The opaque context body.
 */
export function OpaqueBody({ content, source, labels }: {
  content: readonly ContextContentBlock[]
  source: unknown
  labels: OpaqueBodyLabels
}): ReactNode {
  return (
    <>
      <ModelFacingContent content={content} labels={labels} />
      <SourceFields source={source} formRendered={false} labels={labels} />
    </>
  )
}

/** One reconciled instruction file, as the durable source records it. */
interface InstructionChange {
  action: 'set' | 'replace' | 'remove'
  path: string
  digest?: string
}

/**
 * Instruction changes read off the source, or null when the record is not a
 * usable instruction list.
 *
 * The read is all-or-nothing: silently dropping one unreadable entry would show
 * a confident, incomplete file list for a log this version cannot fully read.
 * Paths are deduplicated in first-seen order, matching how the header label is
 * derived from the same array.
 */
function instructionChanges(source: unknown): InstructionChange[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['changes']
  if (!Array.isArray(list)) return null
  const changes: InstructionChange[] = []
  const seen = new Set<string>()
  for (const entry of list as readonly unknown[]) {
    const change = asRecord(entry)
    if (change === null) return null
    const path = change['path']
    if (typeof path !== 'string' || path === '') return null
    const action = change['action']
    // The action decides which word the row shows, so an unrecognized one is
    // not a readable change — it would be presented as loaded or updated.
    if (action !== 'set' && action !== 'replace' && action !== 'remove') return null
    const digest = change['digest']
    if (seen.has(path)) continue
    seen.add(path)
    changes.push({ action, path, ...typeof digest === 'string' ? { digest } : {} })
  }
  return changes.length === 0 ? null : changes
}

/**
 * Locale key for one reconciled file. The baseline loads a file; a later delta
 * distinguishes a newly reconciled path from a rewritten one, which `set` and
 * `replace` already separate at the producer.
 *
 * ROOST-CHANGE 1：返回的是 `labels.instructions` 的字段名，上游返回的是 locale key。
 * @param action - the durable change action.
 * @param baseline - whether this context is the startup/resume baseline.
 * @returns the key naming what happened to that file.
 */
function instructionAction(
  action: InstructionChange['action'],
  baseline: boolean,
): keyof InstructionActionLabels {
  if (action === 'remove') return 'removed'
  if (baseline) return 'loaded'
  return action === 'set' ? 'added' : 'updated'
}

/**
 * `instructions` form: the files this context reconciled, then their text.
 *
 * The text keeps its `<system-reminder>` framing verbatim — the framing is part
 * of what the model read, so hiding it would misreport the request.
 * @param props - Durable content, its source, and the labels.
 * @returns The instructions context body, or the opaque body when the change
 * list is unreadable.
 */
export function InstructionsBody({ content, source, labels }: ContextBodyProps): ReactNode {
  const changes = instructionChanges(source)
  if (changes === null) return <OpaqueBody content={content} source={source} labels={labels} />
  const baseline = asRecord(source)?.['baseline'] === true
  return (
    <>
      <ul className={css.files} data-context-files>
        {changes.map(change => (
          <li key={change.path} className={css.file} title={change.digest}>
            <span className={css.filePath}>{change.path}</span>
            <span className={css.fileAction}>
              {labels.instructions[instructionAction(change.action, baseline)]}
            </span>
          </li>
        ))}
      </ul>
      <ModelFacingContent content={content} labels={labels} />
    </>
  )
}

/** One catalog entry, as the durable source records it. */
interface CatalogEntry {
  name: string
  description: string
}

/**
 * Catalog entries read off the source, or null when the record is not a usable
 * catalog. All-or-nothing for the same reason as the instruction list: this body
 * replaces the model-facing text, so a partial list would hide the only complete
 * account of what the model read.
 */
function catalogEntries(source: unknown): CatalogEntry[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['entries']
  if (!Array.isArray(list)) return null
  const entries: CatalogEntry[] = []
  for (const item of list as readonly unknown[]) {
    const entry = asRecord(item)
    if (entry === null) return null
    const name = entry['name']
    const description = entry['description']
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return null
    entries.push({ name, description })
  }
  // An empty list is a real catalog: a replacement with no entries retires
  // every earlier name. Only an unreadable shape falls back.
  return entries
}

/**
 * `catalog` form: the published entries as a list, read from the source rather
 * than re-parsed out of the model-facing prose.
 *
 * A catalog whose source carries no usable entries falls through to the opaque
 * body, so an older or hand-edited log still shows its text.
 * @param props - Durable content, its source, and the labels.
 * @returns The catalog context body, or the opaque body when the entry list is
 * unreadable.
 */
export function CatalogBody({ content, source, labels }: ContextBodyProps): ReactNode {
  const entries = catalogEntries(source)
  if (entries === null) return <OpaqueBody content={content} source={source} labels={labels} />
  const update = asRecord(source)?.['update'] === true
  // Entry count is unbounded (a provider may publish any number of skills), and
  // the scrollport bounds height, not node count — so the list bounds itself.
  const shown = entries.slice(0, MAX_ENTRIES)
  const rest = unknownBlocks(content)
  return (
    <>
      {update && <p className={css.catalogNotice} data-context-catalog-update>{labels.catalogReplaced}</p>}
      <ul className={css.entries} data-context-entries>
        {shown.map((entry, index) => (
          // Index key: a hand-edited or foreign log may repeat a name, and a
          // duplicate React key would drop a row the model did see.
          <li key={index} className={css.entry}>
            <code className={css.entryName}>{entry.name}</code>
            <span className={css.entryDescription}>{entry.description}</span>
          </li>
        ))}
      </ul>
      {shown.length < entries.length && (
        <p className={css.catalogNotice} data-context-entries-truncated>
          {labels.catalogMore(entries.length - shown.length)}
        </p>
      )}
      {/* The block union is merge-extensible: a catalog message carrying an
          unknown block still shows it rather than dropping model-visible content. */}
      <UnknownBlocks blocks={rest} labels={labels} />
    </>
  )
}

/** One named contribution to a runtime snapshot, as the durable source records it. */
interface SnapshotSection {
  name: string
  text: string
}

/** Snapshot sections read off the source, or null when the record is unusable. */
function snapshotSections(source: unknown): SnapshotSection[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['sections']
  if (!Array.isArray(list)) return null
  const sections: SnapshotSection[] = []
  for (const item of list as readonly unknown[]) {
    const section = asRecord(item)
    if (section === null) return null
    const name = section['name']
    const text = section['text']
    if (typeof name !== 'string' || name === '' || typeof text !== 'string') return null
    sections.push({ name, text })
  }
  return sections.length === 0 ? null : sections
}

/**
 * `snapshot` form: the named contributions this snapshot assembled, in order.
 *
 * The sections are the same bytes the model read, split at the boundaries the
 * producer assembled them on, so a reader sees which subsystem contributed
 * which state instead of one undifferentiated wall.
 *
 * One sentence of the model-facing text is NOT in any section: the producer's
 * framing line declaring that this snapshot supersedes earlier ones. Unlike the
 * `<system-reminder>` wrapper an instruction context carries — which wraps
 * content and cannot be separated from it — that line states the form's own
 * semantics, so the body states them as a caption instead of reprinting the
 * joined prose beside the sections it was split from.
 * @param props - Durable content, its source, and the labels.
 * @returns The snapshot context body, or the opaque body when unreadable.
 */
export function SnapshotBody({ content, source, labels }: ContextBodyProps): ReactNode {
  const sections = snapshotSections(source)
  /* v8 ignore next -- contextBody reads the sections before choosing this body. */
  if (sections === null) return <OpaqueBody content={content} source={source} labels={labels} />
  return (
    <>
      <p className={css.catalogNotice} data-context-snapshot-supersedes>
        {labels.snapshotSupersedes}
      </p>
      <dl className={css.sections} data-context-sections>
        {sections.map((section, index) => (
          <div key={index} className={css.section}>
            <dt className={css.sectionName}>{section.name}</dt>
            <dd className={css.sectionText}>{boundedText(section.text, labels)}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * `notice` form: what just happened, with the model-facing text beneath it.
 *
 * The one-line account also rides the collapsed row ({@link contextBody}), so a
 * notice is usually readable without expanding at all.
 * @param props - Durable content, its source, and the labels.
 * @returns The notice context body.
 */
export function NoticeBody({ content, labels }: ContextBodyProps): ReactNode {
  return <ModelFacingContent content={content} labels={labels} />
}

/**
 * `relay` form: which agent sent this, then what it said.
 *
 * The sender is an opaque session id; it is shown as a field rather than a
 * label, because this client cannot resolve it to a title.
 * @param props - Durable content, its source, and the labels.
 * @returns The relay context body.
 */
export function RelayBody({ content, source, labels }: ContextBodyProps): ReactNode {
  const sender = relaySender(source)
  /* v8 ignore next -- contextBody resolves the sender before choosing this body. */
  if (sender === null) return <OpaqueBody content={content} source={source} labels={labels} />
  return (
    <>
      <p className={css.relaySender} data-context-relay-sender>
        {labels.relayFrom(sender)}
      </p>
      <ModelFacingContent content={content} labels={labels} />
    </>
  )
}

/** The sending agent's session id, or null when the record does not name one. */
function relaySender(source: unknown): string | null {
  const sender = asRecord(source)?.['senderSessionId']
  return typeof sender === 'string' && sender !== '' ? sender : null
}

/** One recalled session, as the durable source records it. */
interface RecalledSession {
  label: string
  retained: number
  omitted: number
  truncated: boolean
}

/** Recalled sessions read off the source, or null when the record is unusable. */
function recalledSessions(source: unknown): RecalledSession[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['references']
  if (!Array.isArray(list)) return null
  const sessions: RecalledSession[] = []
  for (const item of list as readonly unknown[]) {
    const reference = asRecord(item)
    if (reference === null) return null
    const label = reference['label']
    const retained = reference['retainedMessages']
    const omitted = reference['omittedMessages']
    const truncated = reference['truncated']
    // Completeness is the fact this card exists to report, so a reference that
    // cannot state it is not a readable recall — showing the label alone would
    // present a confident card over unknown loss.
    if (typeof label !== 'string' || label === ''
      || typeof retained !== 'number' || typeof omitted !== 'number'
      || typeof truncated !== 'boolean') return null
    sessions.push({ label, retained, omitted, truncated })
  }
  return sessions.length === 0 ? null : sessions
}

/**
 * `recall` form: which sessions this material came from and how much of each
 * survived the read, then the material itself.
 *
 * Completeness is the fact a reader needs first: recalled context is bounded on
 * the way in, so a card that hid the omitted count would overstate what the
 * model received.
 * @param props - Durable content, its source, and the labels.
 * @returns The recall context body, or the opaque body when unreadable.
 */
export function RecallBody({ content, source, labels }: ContextBodyProps): ReactNode {
  const sessions = recalledSessions(source)
  if (sessions === null) return <OpaqueBody content={content} source={source} labels={labels} />
  return (
    <>
      <ul className={css.recalls} data-context-recalls>
        {sessions.map((session, index) => (
          <li key={index} className={css.recall}>
            <span className={css.recallLabel}>{session.label}</span>
            <span className={css.recallCounts}>
              {labels.recallCounts(session.retained, session.omitted)}
            </span>
            {session.truncated && (
              <span className={css.recallCounts}>{labels.recallTruncated}</span>
            )}
          </li>
        ))}
      </ul>
      <ModelFacingContent content={content} labels={labels} />
    </>
  )
}

/** The one-line account a `notice` puts on its collapsed row, when it records one. */
function noticeSummary(source: unknown): string | null {
  const summary = asRecord(source)?.['summary']
  return typeof summary === 'string' && summary !== '' ? summary : null
}

/**
 * Choose the body for one context node.
 *
 * Returns the form the body actually rendered as, which is not always the
 * declared one: a declared form whose fields are unreadable falls back to
 * opaque, and the caller labels the row with what it really shows.
 * `summary` is the collapsed row's one-line account, which only a `notice`
 * records: its whole point is being readable without expanding.
 * @param form - the producer-declared form projected onto the node.
 * @param props - durable content, its source, and the labels.
 * @returns the rendered form (null for opaque), its collapsed summary, and its body.
 */
export function contextBody(
  form: KnownContextForm | null,
  props: ContextBodyProps,
): { rendered: KnownContextForm | null; summary: string | null; body: ReactNode } {
  const opaque = { rendered: null, summary: null, body: <OpaqueBody {...props} /> }
  switch (form) {
    case 'instructions':
      return instructionChanges(props.source) === null
        ? opaque
        : { rendered: 'instructions', summary: null, body: <InstructionsBody {...props} /> }
    case 'catalog':
      return catalogEntries(props.source) === null
        ? opaque
        : { rendered: 'catalog', summary: null, body: <CatalogBody {...props} /> }
    case 'snapshot':
      return snapshotSections(props.source) === null
        ? opaque
        : { rendered: 'snapshot', summary: null, body: <SnapshotBody {...props} /> }
    case 'notice': {
      const summary = noticeSummary(props.source)
      return summary === null
        ? opaque
        : { rendered: 'notice', summary, body: <NoticeBody {...props} /> }
    }
    case 'relay':
      return relaySender(props.source) === null
        ? opaque
        : { rendered: 'relay', summary: null, body: <RelayBody {...props} /> }
    case 'recall':
      return recalledSessions(props.source) === null
        ? opaque
        : { rendered: 'recall', summary: null, body: <RecallBody {...props} /> }
    case null:
      return opaque
    /* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
    KnownContextForm here rather than letting it degrade to opaque silently. */
    default: {
      const unreachable: never = form
      throw new Error(`unreachable context form: ${String(unreachable)}`)
    }
  }
}
