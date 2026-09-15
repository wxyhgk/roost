/*
  逐字取自 deepseek-harness（MIT，`packages/client/ui-primitives/src/user-text.tsx`，提交 0d1f500）。
  **这个文件一个字符都没改**，ROOST-CHANGE 只在配套的 ./user-text.module.css 里（一行
  `display: inline`，见那个文件的文件头）。

  为什么整个搬过来而不是「用户文本当纯文本画」：MessageItem 的气泡就是靠它把
  `@文件`、`@会话`、`/技能` 这三种引用画成芯片的；少了它，气泡里会直接露出
  `@[某会话](dsh-session:...)` 这种线格式。**它本身不解析 markdown**，这一点和我们
  「用户消息不按 markdown 渲染」的取向正好一致——它引 MarkdownText.module.css 只为借
  `.fileMention` 一条样式，和 markdown 渲染树没有代码上的关系。

  `references`（openFile / openSkill）这条支路我们暂时没有调用方——Roost 还没有点开
  文件预览这件事，MessageItem 的平 props 也没把它露出去。故意不删：删了就等于改了上游的
  渲染结构，将来重新同步要做三方合并，而留着的代价只是一段死代码（和
  chat/MessageIconActions.tsx 里的 onBranch 同一个理由）。
*/import type { ReactNode } from 'react'
import clsx from 'clsx'
import { ReferenceIcon } from './ReferenceIcon.tsx'
import css from './user-text.module.css'
import markdownCss from './markdown/MarkdownText.module.css'

/** The wire form a session chip serializes to; label is the display text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/** Sentence punctuation a bare `@name` token may carry without being part of the reference. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u

interface DecorationRange {
  readonly start: number
  readonly end: number
  /** Matched source text (hover title). */
  readonly label: string
  readonly kind: 'session' | 'plain'
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string
}

/** Optional navigation supplied by consumers that can preview references. */
export interface UserTextReferences {
  /** Open a file path decoded from an `@` mention. */
  openFile: (path: string) => void
  /** Open the source of a skill loaded for this message. */
  openSkill: (name: string) => void
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as: the skills the
 * host loaded for this message, or the command a command bubble echoes
 * (unsent queue rows pass none).
 * @param slashKind - the chip kind those tokens render as.
 * @param references - optional file and skill preview actions; session and command tokens stay labels.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
  references?: UserTextReferences,
): ReactNode {
  const ranges: DecorationRange[] = []
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display: wire[1] as string, // non-optional capture in SESSION_WIRE_RE
    })
  }
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  // A `/` token ends at whitespace or the text end like the host skill
  // gesture; only `@` tokens shed sentence punctuation below.
  const re = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1] as string).length // (^|\s) captures '' at line start
    const rawLabel = m[2] as string // non-optional alternation capture
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length <= 1) continue
    if (label.startsWith('/') && !slashNames.includes(label.slice(1))) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  const rankOf = (range: DecorationRange): number => range.kind === 'session' ? 0 : 1
  ranges.sort((a, b) => a.start - b.start || rankOf(a) - rankOf(b) || b.end - a.end)
  const parts: ReactNode[] = []
  let cursor = 0
  const pushPlain = (from: number, to: number): void => {
    parts.push(<span key={`t${from}`} className={css.plainRun}>{text.slice(from, to)}</span>)
  }
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) pushPlain(cursor, tokenStart)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.replace(/^@"|"$/gu, '').endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = range.display
      ?? (referenceKind === undefined
        ? label
        : referenceKind === 'session'
          ? label.slice(1)
          : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1))
    const contents = <>
      {referenceKind !== undefined && (
        <ReferenceIcon kind={referenceKind} size={16} className={css.refIcon} />
      )}
      {displayLabel}
    </>
    const open = references === undefined ? undefined
      : referenceKind === 'file'
        ? () => { references.openFile(label.slice(1).replace(/^"|"$/gu, '')) }
        : referenceKind === undefined && slashKind === 'skill'
          ? () => { references.openSkill(label.slice(1)) }
          : undefined
    const className = clsx(css.refChip, referenceKind === undefined && css.slashChip)
    parts.push(open === undefined
      ? <span key={tokenStart} className={className} data-ref-chip={referenceKind ?? slashKind} title={label}>
        {contents}
      </span>
      : <button
        key={tokenStart}
        type="button"
        className={clsx(className, markdownCss.fileMention)}
        data-ref-chip={referenceKind ?? slashKind}
        title={label}
        onClick={(event) => {
          if (event.detail > 1 || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
          open()
        }}
      >
        {contents}
      </button>)
    cursor = end
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>
  if (cursor < text.length) pushPlain(cursor, text.length)
  return <>{parts}</>
}
