/*
  消息主体：用户气泡、重试行、回合错误、max-tokens 提示、未知面，共五种视图。

  抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/MessageItem.tsx`，
  提交 0d1f500）。**渲染结构（元素、顺序、className、data-* 属性、role）一行未动**，
  改的全是「数据怎么进来」。ROOST-CHANGE 逐条：

  1. **props 从他们的节点类型换成平的数据。** 上游每个视图的入口都是
     `ChatNodeViewProps<'user' | 'turn-error' | ...>`，那是 ChatView 的 slot 运行时递进来的
     一个节点句柄（`node.data` 是快照里的节点、外加 `renderMessageImages` / `openFile` /
     `openSkill` / `t` 四个 seat）。我们没有那套运行时，也不想让调用方去理解「节点」。
     所以每个视图收一组平参数，最外面再给一个 `MessageItem`：**谁说的（role）、说了什么
     （text / attachments / extraBlocks）、出没出错（error）**，三样就够。

  2. **文案从 `t(key, params)` 换成平的 labels 对象。** 同 CompactionItem / MessageIconActions
     的做法：复数和日期在我们的 i18n 里是另一套写法，让调用方拼好递进来，这个目录就不必
     认识任何字典。

  3. **图片附件。** 上游走 slot 的 `renderMessageImages({ images, align, compact })`，
     我们没有图片管线；附件里的图片改成由调用方给一个 `render(compact)` 回调——
     `compact`（附件多于一张时为真）仍然由这里算，和上游一致。

  4. **助手正文这一支是加的，不是抄的。** 上游 MessageItem.tsx 里没有助手视图（在
     AssistantMarkdown.tsx，153 行 + 自己的样式表，这次没搬）。这里的 `role: 'assistant'`
     只是「不套气泡、正文直出」——**一条 CSS 规则都没用**，所以它不会和将来搬进来的
     那份助手外壳打架。不套气泡是我们自己的取向（见提交 83e6133）。

  5. **删掉的三个导出。** `ContextMessageNodeView`（要 ContextInjectionRow，没搬）、
     `CompactionNodeView`（CompactionItem 早一步单独搬过，有自己的平 props）、
     `PendingSteeringBubble` / `PendingSubmissionBubble`（要他们 api-session-controller 的
     `PendingSubmission` 类型）。后两个只是 `UserStyleBubble` 加不同的旗标，而
     `UserStyleBubble` 这里是导出的、`pending` / `echo` 两个旗标原样留着，所以那两种画法
     一点没丢，调用方自己传旗标即可。

  6. **`contentParts` 没有了。** 它做的是把节点的 `content: unknown[]` 拆成文本 / 附件 /
     剩下的块三堆——平 props 进来时这三样本来就是分开的，留着它等于把刚拆开的东西再拼
     回去。`rest`（解析不出来的块）改名 `extraBlocks`，仍旧按 JsonBlock 画。

  7. **重试倒计时的锚点。** 上游是 `useMemo(..., [node.delayMs, node.seq])`，`seq` 是快照
     里的节点序号；我们用 `retry`（第几次重试）代替，同一条重试链里它同样是每次都变的。
*/
import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fileExtension, FileTypeIcon } from '../FileTypeIcon.tsx'
import { fileSizeText } from '../file-size.ts'
import { JsonBlock } from '../markdown/JsonBlock.tsx'
import { MarkdownText, type MarkdownLabels } from '../markdown/MarkdownText.tsx'
import { StateDot } from '../StateDot.tsx'
import { projectUserText } from '../user-text.tsx'
import css from './MessageItem.module.css'

/** 不传 markdownLabels 时的占位，同 CompactionItem 的做法。 */
const NO_MARKDOWN_LABELS: MarkdownLabels = { code: { copyLabel: '', copiedLabel: '' }, footnotes: '' }

/**
 * 气泡上方挂的一枚附件。
 *
 * 图片这一支带的是回调而不是现成的节点：上游按「附件是不是多于一张」切紧凑排版，
 * 那个判断这里还在做（`compact`），所以要等到画的时候才知道结果。
 */
export type MessageAttachment =
  | { readonly type: 'image'; readonly render: (compact: boolean) => ReactNode }
  | { readonly type: 'file'; readonly name: string; readonly bytes: number }

/** 用户气泡要的文案。 */
export interface UserMessageLabels {
  /** 正文里解析不出来的块，JsonBlock 的标题（上游 `message.extraBlock`）。 */
  extraBlock: string
  /** JsonBlock 正文超长时的脚注（上游 `json.truncated`）。 */
  jsonTruncated: (total: number) => string
}

/** 回合错误行要的文案。 */
export interface TurnErrorLabels {
  /** 「本回合失败」这类标题（上游 `message.turnError`）。 */
  turnError: string
  /** code 为 `AUTH` 时顶掉原始 message 的那句（上游 `message.failure.auth`）。 */
  authFailure: string
}

/** max-tokens 提示要的文案。 */
export interface TurnMaxTokensLabels {
  /** 标题（上游 `message.maxTokens`）。 */
  maxTokens: string
  /** 标题后面那句解释（上游 `message.maxTokens.hint`）。 */
  maxTokensHint: string
}

/** 一条消息的错误态。两种终态，都画在正文下面。 */
export type MessageError =
  | { readonly kind: 'failed'; readonly message: string; readonly code?: string | undefined }
  | { readonly kind: 'max-tokens' }

/*
  ROOST-CHANGE：上游这里是 `failureMessage(message, code, t)`，第三个参数是 locale seat。
*/
function failureMessage(message: string, code: unknown, authFailure: string): string {
  return code === 'AUTH' ? authFailure : message
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

/** 重试行要的文案。整句状态由调用方拼，因为复数规则在我们的 i18n 里是另一套写法。 */
export interface ModelRetryLabels extends Pick<TurnErrorLabels, 'authFailure'> {
  /** 「{label} 第 {retry}/{maximum} 次，{seconds} 秒后」整句（上游 `message.retry.status`）。 */
  status: (parts: { label: string; retry: number; maximum: number | string; seconds: number }) => string
  /** 四种状态各自的词（上游 `message.retry.{active,cancelled,started,scheduled}`）。 */
  active: string
  cancelled: string
  started: string
  scheduled: string
  /** 展开后两行的前缀（上游 `message.retry.delay` / `message.retry.failure`）。 */
  delay: string
  failure: string
  /** 毫秒数的本地写法（上游 `duration.milliseconds`）。 */
  duration: (milliseconds: number) => string
}

export interface ModelRetryRowProps {
  /** 这是第几次重试。同时是倒计时的锚点，见文件头第 7 条。 */
  retry: number
  /** 上限。上游无限重试模式下画的是 `'∞'`，传什么由调用方决定。 */
  maximum: number | string
  /** 主机侧安排的等待时长。 */
  delayMs: number
  /** 主机侧记的重试状态。 */
  state: 'scheduled' | 'started' | 'cancelled'
  /** 是否正在倒计时（上游是 `retryState === 'scheduled'`，但由外层算好递进来）。 */
  active: boolean
  /** 触发这次重试的失败。 */
  failure: { readonly message: string; readonly code?: string | undefined }
  labels: ModelRetryLabels
}

/**
 * Renders one scheduled or finished model retry as a collapsible status row.
 * @param props - the retry's ordinal, delay, state and failure, plus copy.
 * @returns the retry row.
 */
export function ModelRetryRow({ retry, maximum, delayMs, state, active, failure, labels }: ModelRetryRowProps) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + delayMs, [delayMs, retry])
  const scheduledSeconds = retrySeconds(delayMs)
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? labels.active
    : state === 'cancelled'
      ? labels.cancelled
      : state === 'started'
        ? labels.started
        : labels.scheduled
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {labels.status({ label, retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{labels.delay}</span>
          {labels.duration(Math.round(delayMs))}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{labels.failure}</span>
          {failureMessage(failure.message, failure.code, labels.authFailure)}
        </div>
      </div>
    </details>
  )
}

export interface TurnErrorRowProps {
  message: string
  code?: string | undefined
  labels: TurnErrorLabels
}

/** Persistent, turn-positioned feedback for a terminal failure. */
export function TurnErrorRow({ message, code, labels }: TurnErrorRowProps) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{labels.turnError}</span>
        <span className={css.turnErrorMessage}>{failureMessage(message, code, labels.authFailure)}</span>
      </div>
      {code !== undefined && <code className={css.turnErrorCode}>{code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
export function TurnMaxTokensRow({ labels }: { labels: TurnMaxTokensLabels }) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{labels.maxTokens}</span>
        <span className={css.turnErrorMessage}>{labels.maxTokensHint}</span>
      </div>
    </div>
  )
}

export interface UserStyleBubbleProps {
  /** 消息正文。**不按 markdown 渲染**，只过 projectUserText 把引用画成芯片。 */
  text: string
  /** 气泡上方的附件行；空数组和不传等价。 */
  attachments?: readonly MessageAttachment[]
  /** 正文之外、解析不出来的块，按 JSON 折叠画（上游的 `rest`）。 */
  extraBlocks?: readonly unknown[]
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Skill names the step's `skill-invocation` injections loaded for this message. */
  skillNames?: readonly string[]
  /**
   * 气泡下面那行「引用了 X、Y」。
   *
   * ROOST-CHANGE：上游把 referenceLabels 用分隔符拼进一条模板，这里要整句。画不画的条件
   * 也跟着从「有 referenceLabels」变成「给了这句话」——一句空话没有意义，而
   * referenceLabels 本身另有用途（喂 projectUserText）。
   */
  referenceSummary?: string
  labels: UserMessageLabels
}

/** Right-aligned bubble shared by user and steering rows. */
export function UserStyleBubble({
  text, attachments = [], extraBlocks = [], actions, pending = false, echo = false,
  referenceLabels = [], skillNames = [], referenceSummary, labels,
}: UserStyleBubbleProps): ReactNode {
  const compactImages = attachments.length > 1
  const showBubble = text !== '' || extraBlocks.length > 0
  return (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
    >
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {attachment.render(compactImages)}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.name}>
                  <FileTypeIcon path={attachment.name} className={css.fileIcon} />
                  <span className={css.fileContent}>
                    <span className={css.fileName}>{attachment.name}</span>
                    <span className={css.fileMeta}>
                      {[fileExtension(attachment.name).toUpperCase().slice(0, 8), fileSizeText(attachment.bytes)]
                        .filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels, skillNames, 'skill')}
          {extraBlocks.map((block, i) => (
            <JsonBlock key={i} label={labels.extraBlock} payload={block} truncatedLabel={labels.jsonTruncated} />
          ))}
        </div>}
        {referenceSummary !== undefined && (
          <div className={css.referenceSummary}>{referenceSummary}</div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

export interface UnknownSurfaceRowProps {
  /** 未知面的类型名，进标题。 */
  type: string
  payload: unknown
  labels: {
    /** 上游 `message.unknownSurface`，带一个 type 参数。 */
    unknownSurface: (type: string) => string
    jsonTruncated: (total: number) => string
  }
}

/** Explicit unknown-surface renderer. */
export function UnknownSurfaceRow({ type, payload, labels }: UnknownSurfaceRowProps) {
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={labels.unknownSurface(type)}
        payload={payload}
        truncatedLabel={labels.jsonTruncated}
      />
    </div>
  )
}

/** `MessageItem` 要的全部文案，是上面三组的并集。 */
export interface MessageItemLabels extends UserMessageLabels, TurnErrorLabels, TurnMaxTokensLabels {}

export interface MessageItemProps {
  /** 谁说的。用户走右对齐气泡，助手走不套气泡的正文（见文件头第 4 条）。 */
  role: 'user' | 'assistant'
  /** 说了什么。 */
  text: string
  /** 正文之外、解析不出来的块，按 JSON 折叠画。 */
  extraBlocks?: readonly unknown[]
  /** 用户消息才画附件；助手这一支忽略它。 */
  attachments?: readonly MessageAttachment[]
  /** 出没出错。两种终态都画在正文下面。 */
  error?: MessageError
  /** 助手正文的渲染器。不给就走已 vendor 的 MarkdownText。 */
  renderBody?: (text: string) => ReactNode
  /** 走默认 MarkdownText 时它要的文案（代码块的复制按钮、脚注标题）。 */
  markdownLabels?: MarkdownLabels
  /** 正文下面那一行（我们塞 MessageIconActions），拿到的是这条消息的纯文本。 */
  actions?: (text: string) => ReactNode
  /** 只对用户消息有意义的三个，形状和用途见 UserStyleBubbleProps。 */
  referenceLabels?: readonly string[]
  skillNames?: readonly string[]
  referenceSummary?: string
  labels: MessageItemLabels
}

/**
 * Renders one conversation message plus its terminal error state.
 * @param props - who spoke, what they said, and whether the turn failed.
 * @returns the message body, followed by the error row when one is present.
 */
export const MessageItem = memo(function MessageItem({
  role, text, extraBlocks = [], attachments, error, renderBody, markdownLabels = NO_MARKDOWN_LABELS,
  actions, referenceLabels, skillNames, referenceSummary, labels,
}: MessageItemProps) {
  const errorRow = error === undefined
    ? null
    : error.kind === 'max-tokens'
      ? <TurnMaxTokensRow labels={labels} />
      : <TurnErrorRow message={error.message} code={error.code} labels={labels} />
  if (role === 'user') {
    return (
      <>
        <UserStyleBubble
          text={text}
          {...attachments === undefined ? {} : { attachments }}
          extraBlocks={extraBlocks}
          {...actions === undefined ? {} : { actions }}
          {...referenceLabels === undefined ? {} : { referenceLabels }}
          {...skillNames === undefined ? {} : { skillNames }}
          {...referenceSummary === undefined ? {} : { referenceSummary }}
          labels={labels}
        />
        {errorRow}
      </>
    )
  }
  /*
    助手这一支不套气泡、不占任何 MessageItem.module.css 的类——理由见文件头第 4 条。
    `data-message-role` 留给测试和调试选择用，和上游 `data-submission-echo` 那些是一路。
  */
  return (
    <div data-message-role="assistant">
      {renderBody ? renderBody(text) : <MarkdownText text={text} labels={markdownLabels} />}
      {extraBlocks.map((block, i) => (
        <JsonBlock key={i} label={labels.extraBlock} payload={block} truncatedLabel={labels.jsonTruncated} />
      ))}
      {errorRow}
      {actions?.(text)}
    </div>
  )
})
