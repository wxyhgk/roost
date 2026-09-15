/*
  所有工具卡片共用的那层壳：图标、标题、摘要、四种状态、展开后的 INPUT/OUTPUT，
  以及把 diff / read / terminal / search / web / image 几种卡片模型分派到对应积木上。

  逐字抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`，
  提交 0d1f500）。**渲染结构（元素、顺序、className、data-* 属性、那一长串三元的分派顺序）
  一行未动**；改的全在「值从哪来」这一侧，共五处 ROOST-CHANGE，都标在原位：

  1. **`t`（`TranslateNS<'conversation'>`）→ 平的 `labels`。** 上游那个是 slot 运行时的
     locale seat，我们没有；连带 `primitive-labels.ts` 和 `terminalBlockLabels()` 那几个
     适配器也不用搬——积木要的 labels 由调用方拼好递进来。
  2. **积木从已经 vendor 的那份取**，不搬第二份。注意 `ReadBlock` / `CodeBlock` / `WebBlock`
     在 `../../highlighted.ts` 而不是 `../../index.ts`（理由见 index.ts 顶上：它们静态吃 shiki）。
     **这也意味着 ToolRow 自己就在「会拖进 shiki」的那一档**——挂它的地方得是懒加载的
     chunk，对话视图本来就是。
  3. **图片画廊那个 slot 去掉了**（`PropsRenderSlots<'tool.call.images'>` + `MessageImageLoader`
     两个 prop，以及 `renderSlot('tool.call.images', …)` 那一次调用）。我们没有附件管线，
     换成 `ImageCardModel.gallery` 这个 `ReactNode`——**渲染路径留着，调用方不传就不画**，
     照 `chat/MessageIconActions.tsx` 的 `onBranch` 那条先例。
  4. **`AskQuestionCard` 换成一个 `ReactNode`。** 那个组件（和它的 module.css）这次不在
     搬运范围里，而它在分派链上排第一——删掉这一支就是改了上游的结构。收节点既保住了
     顺序，又不用把一个我们暂时用不上的组件一起拖进来。
  5. **`localizeTerminalCardModel(terminal, t)` 去掉了**：`TerminalCardModel` 已经是上游
     localize 之后的形状（见 models/terminal-card-model.ts 第 2 条），这里直接用。

  四态的判定规则不在这个文件里，在 `models/tool-call-model.ts` 的 `toolRowModel()`；
  这里只把 `state` 画出来：error/stopped 顶掉图标换成 StateDot，running 靠 CSS 那道扫光，
  三者都另配一条读屏专用文本（点和扫光都是 aria-hidden 的纯颜色）。
*/
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  DiffBlock, DisclosureRow, IconInspectOutline12, SearchBlock, StateDot, TerminalBlock, diffTotals,
  type DiffBlockLabels, type SearchBlockLabels, type TerminalBlockLabels,
} from '../../index.ts'
// ROOST-CHANGE 2：吃 shiki 的三块在另一个入口。
import {
  CodeBlock, ReadBlock, WebBlock, type ReadBlockLabels, type WebBlockLabels,
} from '../../highlighted.ts'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from './models/diff-card-model.ts'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from './models/read-card-model.ts'
import type { ImageCardModel } from './models/image-card-model.ts'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from './models/search-card-model.ts'
import type { TerminalCardModel } from './models/terminal-card-model.ts'
import { formatToolBody, type ToolRowState, type ToolRowVariant } from './models/tool-call-model.ts'
import type { WebCardModelProps } from './models/web-card-model.ts'
import css from './ToolRow.module.css'

/**
 * ROOST-CHANGE 1：这一行要的全部文案。上游从 locale seat 现取，我们要求调用方拼好递进来。
 *
 * **五个积木的 labels 是必填的，不是可选的。** 可选的话，「传了 diff 卡片却忘了 diff
 * labels」就变成一次静默的空渲染——而这一层最不该发生的事就是卡片悄悄消失。调用方在
 * 模块级拼一个常量、每次原样传进来即可（积木自己一个字符串都不自带，这是 vendor/dsh
 * 整批组件的惯例）。
 */
export interface ToolRowLabels {
  /** 读屏专用的运行态文本。 */
  running: string
  /** 读屏专用的失败态文本。 */
  failed: string
  /** 读屏专用的中断态文本。 */
  stopped: string
  /** 展开后 INPUT 段的栏标。 */
  input: string
  /** 展开后 OUTPUT 段的栏标。 */
  output: string
  /** 悬停才出现的那颗「查看」小钮。没有 `inspect` 回调时用不到。 */
  inspect: string
  /** CodeBlock 的复制按钮（只有 `code` 变体用得到）。 */
  copy: string
  /** 同上，复制成功后那一秒。 */
  copied: string
  diff: DiffBlockLabels
  read: ReadBlockLabels
  search: SearchBlockLabels
  terminal: TerminalBlockLabels
  web: WebBlockLabels
}

/** ROOST-CHANGE：上游从 ui-chat 取这个类型，这里就地写平。 */
export interface OpenFileOptions {
  /** 1-based 行号。 */
  line?: number | undefined
}

export interface ToolRowProps {
  /** ROOST-CHANGE 1：上游这里是 `t: TranslateNS<'conversation'>`。 */
  labels: ToolRowLabels
  variant: ToolRowVariant
  /** Wire tool name for tool-owned styling layered over the generic variant. */
  toolName?: string | undefined
  icon: ReactNode
  title: string
  summary: string
  /**
   * Trailing summary fragment rendered outside the ellipsized summary text, so
   * a narrow row clips the summary before this. For a fragment whose whole
   * value is surviving that clip — the todo row's parallel-active count.
   * null/absent = the summary is the whole collapsed content. Dropped on an
   * error row, whose collapsed summary is the failure line instead.
   */
  summarySuffix?: string | null | undefined
  /** Original argument JSON formatted only while the row is expanded. */
  bodyRaw?: string | null | undefined
  /** Flattened result text for the expanded Output section; null/absent = no output section. */
  output?: string | null | undefined
  /**
   * Ask-user transcript card; card fields are mutually exclusive and replace text sections.
   *
   * ROOST-CHANGE 4：上游是 `AskQuestionCardModel`，由同目录的 `AskQuestionCard` 画；
   * 那个组件这次不在搬运范围里，所以收一个已经画好的节点。
   */
  askQuestion?: ReactNode
  /** Error first line shown as the collapsed summary on an error row; null/absent = keep `summary`. */
  errorSummary?: string | null | undefined
  /** Terminal card; card fields are mutually exclusive and replace text sections. */
  terminal?: TerminalCardModel | null | undefined
  diff?: DiffCardModel | null | undefined
  read?: ReadCardModel | null | undefined
  /**
   * Image-card material for a call whose result is an image. ROOST-CHANGE 3：
   * 画廊本体是 `ImageCardModel.gallery` 这个节点，上游那两个 slot prop 去掉了。
   */
  image?: ImageCardModel | null | undefined
  search?: SearchCardModel | null | undefined
  web?: WebCardModelProps | null | undefined
  state: ToolRowState
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** 1-based line the call was about; absent = open the file at its beginning. */
  filePathLine?: number | undefined
  /** Open the path (already cwd-resolved), landing on `filePathLine` when given. */
  onOpenFile?: ((path: string, options?: OpenFileOptions) => void) | undefined
  /**
   * Jump to this call in the trajectory view: a hover-revealed Inspect pill
   * over the expanded body. Absent = no affordance.
   */
  inspect?: (() => void) | undefined
}

function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

/** Visually hidden run-state label: the StateDot and the CSS sweep are both
 *  aria-hidden / colour-only, so assistive technology needs this text to know a
 *  row is running, failed, or interrupted. null in the ok state (the icon and
 *  summary already describe a settled row). */
function stateStatus(state: ToolRowState, labels: ToolRowLabels): string | null {
  switch (state) {
    case 'running': return labels.running
    case 'error': return labels.failed
    case 'stopped': return labels.stopped
    default: return null
  }
}

export function ToolRow({
  labels,
  variant,
  toolName,
  icon,
  title,
  summary,
  summarySuffix,
  bodyRaw,
  output,
  askQuestion,
  errorSummary,
  terminal,
  diff,
  read,
  image,
  search,
  web,
  state,
  filePath,
  filePathLine,
  onOpenFile,
  inspect,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  // ROOST-CHANGE 5：上游这里是 `localizeTerminalCardModel(terminal, t)`。
  const terminalBody = terminal ?? null
  const diffBody = diff ?? null
  const readBody = read ?? null
  const imageBody = image ?? null
  const searchBody = search ?? null
  const webBody = web ?? null
  const askQuestionBody = askQuestion ?? null
  const inputRaw = bodyRaw ?? null
  const outputText = output ?? null
  const card = askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody
  const expandable = inputRaw !== null || outputText !== null || card !== null
  const open = expanded && expandable
  const bodyText = useMemo(
    () => open && card === null && inputRaw !== null ? formatToolBody(variant, inputRaw) : null,
    [card, inputRaw, open, variant],
  )
  const status = stateStatus(state, labels)
  // A failure must replace, not supplement, the normal summary.
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const summaryText = failureLine ?? terminalBody?.description ?? summary
  // A diff row's collapsed line carries the card's +/- totals (the same
  // numbers the expanded footer prints) so the change size reads without
  // expanding; an explicit summarySuffix (none today on diff rows) wins.
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  const suffix = failureLine === null ? summarySuffix ?? diffStat : null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = filePath !== undefined && onOpenFile !== undefined && failureLine === null
    ? (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (filePathLine === undefined) onOpenFile(filePath)
      else onOpenFile(filePath, { line: filePathLine })
    }
    : undefined
  // Keep Enter/Space on the focused path link from bubbling to the row's
  // keydown handler, which would preventDefault() the key and toggle expand
  // instead of activating the link — the keyboard analogue of openFile's
  // stopPropagation. The native button still fires its own onClick from the key.
  const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  // The code variant's program renders through CodeBlock (shiki), so only its
  // output joins the IN/OUT card; every other variant's input does too.
  const cardBody = variant === 'code' ? null : bodyText
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggleExpand}
        collapsedContent={summaryText !== '' && (
          /* An empty summary drops the separator with it (a row that is only
             its title shows no trailing dot). */
          <>
            <span className={css.sep} aria-hidden />
            {openFile !== undefined ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
                onKeyDown={fileLinkKeyDown}
              >
                {summaryText}
              </button>
            ) : (
              <span
                className={clsx(css.summary, failureLine !== null && css.errorSummary)}
              >
                {summaryText}
              </span>
            )}
            {suffix !== null && (
              <span className={clsx(css.summarySuffix, suffix === diffStat && css.diffStat)}>{suffix}</span>
            )}
          </>
        )}
      >
        <div className={css.bodyWrap}>
          {askQuestionBody !== null
            ? askQuestionBody
            : terminalBody !== null
              ? (
                <TerminalBlock
                  {...terminalBody.card}
                  maxLines={Infinity}
                  labels={labels.terminal}
                  className={css.terminalBody}
                />
              )
              : diffBody !== null
                ? <DiffBlock {...diffBody.card} labels={labels.diff} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
                : readBody !== null
                  ? <ReadBlock {...readBody} labels={labels.read} maxLines={CHAT_READ_MAX_LINES} className={css.readBody} />
                  : imageBody !== null
                    ? (
                      /* Label, gallery, then the result's OWN envelope text. The text
                         comes from the image card model (which reads the result's text
                         block), never from the row's flattened output: an image read's
                         content is [text envelope, image block] and flattening
                         JSON.stringifies the image block, printing the raw attachment
                         object under the picture. It is not redundant either — the
                         attachment slot can render nothing, and then this line is the
                         only evidence an image was returned. */
                      <div className={css.imageBody}>
                        <div className={css.imageLabel}>{imageBody.label}</div>
                        {imageBody.gallery}
                        <div className={css.imageMeta}>{imageBody.text}</div>
                      </div>
                    )
                    : searchBody !== null
                      ? (
                        <>
                          <SearchBlock
                            {...searchBody.card}
                            labels={labels.search}
                            maxLines={CHAT_SEARCH_MAX_LINES}
                            className={css.searchBody}
                          />
                          {/* A capped search's recovery locator lives only in the result
                          text; show it below the card so the dropped rows survive. */}
                          {searchBody.recovery !== undefined && (
                            <div className={css.searchRecovery}>{searchBody.recovery}</div>
                          )}
                        </>
                      )
                      : webBody !== null
                        ? <WebBlock {...webBody} labels={labels.web} className={css.webBody} />
                        : (
                          <>
                            {variant === 'code' && bodyText !== null && (
                              <div className={css.bodyScroll}>
                                <CodeBlock code={bodyText} lang="typescript" copyLabel={labels.copy} copiedLabel={labels.copied} className={css.codeBody} />
                              </div>
                            )}
                            {(cardBody !== null || outputText !== null) && (
                              <div className={css.ioCard}>
                                {cardBody !== null && (
                                  <div className={css.ioSection}>
                                    <span className={css.ioLabel}>{labels.input}</span>
                                    <span className={css.ioText}>{cardBody}</span>
                                  </div>
                                )}
                                {cardBody !== null && outputText !== null && (
                                  <span className={css.ioDivider} aria-hidden />
                                )}
                                {outputText !== null && (
                                  <div className={css.ioSection}>
                                    <span className={css.ioLabel}>{labels.output}</span>
                                    <span className={css.ioText} data-error={state === 'error' || undefined}>
                                      {outputText}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
          {inspect !== undefined && (
            <button
              type="button"
              className={css.inspectButton}
              onClick={inspect}
            >
              <IconInspectOutline12 />
              {labels.inspect}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
