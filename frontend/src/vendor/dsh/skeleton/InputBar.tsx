/* 改自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-conversation/src/client/skeleton/InputBar.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。 */
/*
  输入卡。22px 圆角的胶囊：上面一块封顶 14 行（336px）的草稿区，下面一行工具条，
  右下角一颗 34px 的发送圆钮。几何全在 `InputBar.module.css` 里，**那份一行未改**，
  这个文件只负责「值从哪来」。

  DOM 从外到内（顺序、类名、data-* 与上游逐字一致）：

      .root(.hero)
        .notice                        ← 横幅
        .card[data-composer-card]
          .overlayAnchor               ← 浮层锚点（座位，见下）
          .accessory                   ← 座位
          {附件轨}                      ← 座位
          .scroll[data-input-scroll]   ← 唯一会滚的盒子，封顶 336px
            .grow
              .input(.inputDisabled)[data-phase][data-placeholder]
              .placeholder[data-composer-placeholder]
          .row
            .tools    → .add（+ 圆钮）、.modes、左侧座位
            .trailing → 右侧座位、模型座位、用量表座位、独立停止钮、.primary
        {dock}                         ← 座位

  ---- ROOST-CHANGE 逐条 --------------------------------------------------

  1. **插槽运行时整个换成平 props。** 上游这个组件是 `conversation.composer.bar` 插槽的
     条目，机器状态从 cordis 的 provide 通道来（`useSession` / `useInput` / `inputActions`
     / `keyboard` / `useNotices` / `useBusyEnter` / `useFileUploads` / `useMenuLauncher`
     / `useProjection`），文案从 locale seat 的 `t('input.send')` 来，子区域从
     `renderSlot('conversation.input.*')` 来。**这三样我们一样都没有**：没有插件运行时、
     没有 slot 注册表、也没有扁平 key 的 locale seat（本仓的 i18n 是 `packages/i18n` 的
     嵌套对象，形状由 TypeScript 互相约束）。所以：
       - 十个 hook props → 直接的值 props（`draft` / `phase` / `running` / `notice` …）
       - `t(...)` → 已经翻好的字符串 props（`placeholder` / `sendLabel` / `stopLabel`
         / `commandsLabel`），和 `ChatView` 收 `labels` 是同一个做法
       - 每个 `renderSlot('conversation.input.X', …)` → 一个 `ReactNode` prop。
         **喂不满的一律不传、于是不画**（NOTICE.md「没搬什么」那节的规矩），但 prop
         留在接口里，将来有了数据直接传，不用重新对一遍 DOM。

  2. **草稿面由 Lexical 的 contenteditable 换成原生 `<textarea>`。** 这是这次唯一一处
     元素级的改动，而且是被迫的：上游那一层是 `DraftEditor` → `ComposerContentEditable`
     + `DecoratorPortals`，整棵建立在 Lexical 之上（芯片是 decorator portal、键位走
     `installDraftKeymap` 注册到 editor 的 command layer）。Lexical 没搬，芯片、`@` 引用、
     斜杠命令我们也都没有数据，**剩下的需求就只是「一个会自己长高的多行文本框」**——
     那正是 textarea。三层包装（`.scroll` / `.grow` / 文本面）和它们的类名、data-* 原样保留。
     连带的两处：
       - `DraftEditor.tsx` 没有单独搬成一个文件。它在上游是纯呈现、零 hook 的一层，
         存在的理由就是包住 `ComposerContentEditable` 和 `DecoratorPortals`；两者都没搬之后
         它只剩三层 div，单独一个文件就只是包装。DOM 原样内联在下面。
       - `.input p { margin: 0 }` 和 `.input p:last-child::after`（读 `--dsh-composer-hint`
         的幽灵提示）在我们这儿**永远不会命中**：textarea 没有子元素。CSS 逐字留着。

  3. **textarea 要三条内联样式**，而且每一条都有具体的肇事者：
       - `resize: none` —— Tailwind 的 preflight 有 `textarea { resize: vertical }`，
         不压掉就是右下角一个能把卡片拽变形的把手（NOTICE.md 第 3 条那个模式的第三例，
         所以 `frontend/tests/browser/dsh-input-bar.tsx` 才要把这张卡画出来）。
       - `overflow: hidden` —— 会滚的必须是 `.scroll`（它才有 336px 的封顶）。textarea
         自己再滚一次，就是卡片里套了两个滚动条、而且外面那个永远是满的。
       - `height` —— textarea 不会跟着内容长高，得每次改动之后拿 `scrollHeight` 量一遍。
         写成内联样式而不是改 CSS：**`*.module.css` 不许动**（NOTICE.md 的规矩），
         而且这个值本来就是每帧算出来的。
     不改 `.input` 的 padding/字号：preflight 的 `font: inherit` + `background-color:
     transparent` 正好把 textarea 的 UA 默认值清成和上游那个 div 一样的起点。

  4. **`editable=false` 用 `readOnly` 而不是 `disabled`。** 上游那个面是 contenteditable，
     不可编辑时仍然能选中和复制；textarea 的 `disabled` 连选中都不给。`readOnly` 才是
     等价物。视觉上的禁用仍旧走上游的 `.inputDisabled` + `aria-disabled`。

  5. **错误落在 `.notice` 这个座位上，不是 Toast。** 上游把 `promptError` 和
     `notice.level === 'error'` 都送进 `Toast`（一个贴着卡片浮的瞬时条），而 `Toast` 在
     NOTICE.md 的「没搬什么」里点了名。错误必须有落点——409 冲突、网络失败、超长这三条
     全靠它——所以合并到卡片上方那条横幅里，`role` 跟着 `level` 走（error → alert）。
     上游只在 `level === 'info'` 时画它，我们两档都画。

  6. **`uploadsPending` 换成 `sendBlocked`。** 上游那一档的语义是「有东西占着发送闸门，
     但不该锁住输入」（附件还在传）。我们没有附件，却有一个形状完全一样的情况：正文
     超过 15 KiB 的后端上限——能继续删字，但不能发。沿用同一个位置而不是新加一个判断，
     是为了让 `primaryDisabled` 那行表达式和上游对得上。

  7. **键位只留 ⌘/Ctrl+Enter 发送。** 上游是 `installDraftKeymap` 注册到 Lexical 的
     command layer：平 Enter 发送，且要经 `resolveSubmitMode` 在 steer / queue / 普通
     三种投递之间挑一种。那三种投递是上游的会话机器才有的概念，`resolveSubmitMode`
     和 `busyEnter` 都没搬。本仓既有的键位是 Enter 换行、⌘/Ctrl+Enter 发送——对话里
     多行内容是常态，原样保留。

  8. **`onMouseDown` 上的防抢焦点保留，实现换成本地一行。** 上游的 `keepDraftFocus`
     在 `view-binding.ts` 里（要拿 Lexical 的 editor 做 `focus({ preventScroll })`），
     对 textarea 来说 `preventDefault()` 就够了：mousedown 的默认行为就是移焦点。

  9. **去掉的分支**（依赖我们没有的概念，删而不是留死代码；对应的 prop 见接口注释）：
     subagent（父子会话，连带 `interruptible` 那颗独立停止钮的数据来源）、
     `claim` 幽灵提示、`imageLimits` 的入口预检、`useProjection('plan'|'goal')` 的
     placeholder 切换、`canSteerQueue` 的整队改向、`pruneAttachments` 的对账。
     **`interruptible` 这颗按钮本身留着**（`running && stop` 同时喂到就画），因为它和
     `.primary` 是两颗不同的钮、上游的顺序也在这儿。
*/
import { memo, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconPlusOutline16 } from '../icons/index.tsx'
import css from './InputBar.module.css'

/** 卡片上方那条横幅。`level` 决定 `role`：错误要打断读屏，提示不要。 */
export interface InputBarNotice {
  readonly level: 'info' | 'error'
  readonly text: string
}

export interface InputBarProps {
  // ---- 能喂满的 --------------------------------------------------------
  /** 草稿正文。受控，和上游的 `input.draft` 同一个位置。 */
  readonly draft: string
  readonly onDraftChange: (value: string) => void
  /** ⌘/Ctrl+Enter 或点发送钮。到不了这里的状态（空、禁用、提交中、闸门被占）已经被挡掉。 */
  readonly onSubmit: () => void
  /** 空草稿时压在文本面上的那行字，同时充当 textarea 的 aria-label。 */
  readonly placeholder: string
  /** 发送钮的 aria-label（钮上只有一个箭头图形，没有可读文字）。 */
  readonly sendLabel: string
  /**
   * 上游 `input.phase` 的子集，只喂得满三档：
   * - `plain`：普通可编辑
   * - `submitting`：正在提交，输入只读、发送钮失效
   * - `inert`：没有可投递的目标
   * 原样落在 `.input` 的 `data-phase` 上（上游那份 CSS 不读它，留着是为了对得上）。
   */
  readonly phase?: 'inert' | 'plain' | 'submitting'
  /** 整张卡不可用（上游的 `inert`）。 */
  readonly disabled?: boolean
  /**
   * 发送闸门被占着，但输入不锁——用户得能把内容改到能发为止。
   * 见文件头 ROOST-CHANGE 6：这是上游 `uploadsPending` 那一档。
   */
  readonly sendBlocked?: boolean
  /** 卡片上方的横幅。传 `null` 不画。 */
  readonly notice?: InputBarNotice | null
  /** `composer` 是落位态，`hero` 是空会话居中态（`.hero` 会把文本面的下限抬到两行）。 */
  readonly variant?: 'composer' | 'hero'

  // ---- 座位：喂不满就不传，于是不画 -------------------------------------
  /**
   * 对方正在跑。喂到它并且喂到 `stop` 时，空草稿下 `.primary` 变成停止钮。
   * **当前没有数据源**：`shared/api/conversations` 里没有中断某一轮的接口
   * （`cancelDelivery` 取消的是还没写进 CLI 的投递，不是已经开跑的那一轮）。
   */
  readonly running?: boolean
  readonly stop?: () => void
  readonly stopLabel?: string
  /** `+` 圆钮 = 斜杠/`@` 命令菜单的开关（上游 `toggleCommandMenu`，不是附件）。没有菜单就不画。 */
  readonly toggleCommandMenu?: () => void
  readonly commandMenuOpen?: boolean
  readonly commandsLabel?: string
  /** 附件轨（上游 `conversation.input.attachments`）。 */
  readonly attachments?: ReactNode
  /** 浮层锚点（上游 `conversation.input.overlay`）：菜单、弹选贴着卡片定位。 */
  readonly overlay?: ReactNode
  /** 卡片顶部的附加行（上游 `accessory`）。 */
  readonly accessory?: ReactNode
  /** `.modes`：权限档 / 计划模式两个芯片（上游 `conversation.input.permission|plan`）。 */
  readonly modes?: ReactNode
  /** 工具条左段尾部（上游 `conversation.input.left`）。 */
  readonly leading?: ReactNode
  /** 工具条右段头部（上游 `conversation.input.right`）。 */
  readonly trailing?: ReactNode
  /** 模型选择（上游 `conversation.input.model`）。 */
  readonly modelSeat?: ReactNode
  /** 上下文用量表（上游 `<ContextMeter>`，那个组件没搬）。 */
  readonly contextMeter?: ReactNode
  /** 卡片下方的坞（上游 `conversation.composer.dock`），只在落位态出现。 */
  readonly dock?: ReactNode
  /** 没选工作区时整张卡变成「去选一个」的触发器（上游 `onRequestWorkspace`）。 */
  readonly onRequestWorkspace?: () => void
  readonly workspacePickerOpen?: boolean
}

/**
 * 画输入卡。
 * @param props - 草稿、文案、以及各个区域的座位。
 * @returns `.root` 一棵。
 */
export const InputBar = memo(function InputBar({
  draft, onDraftChange, onSubmit, placeholder, sendLabel,
  phase = 'plain', disabled: inert = false, sendBlocked = false, notice = null, variant = 'composer',
  running = false, stop, stopLabel, toggleCommandMenu, commandMenuOpen = false, commandsLabel,
  attachments, overlay, accessory, modes, leading, trailing, modelSeat, contextMeter, dock,
  onRequestWorkspace, workspacePickerOpen = false,
}: InputBarProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)

  const empty = draft.trim() === ''
  // 上游这一串判定的形状原样保留，喂不满的那几项（removed / blocked / parentOffline /
  // live）折进 `inert` 一个开关里——它们在上游都只有「整张卡不可用」这一个后果。
  const locked = inert
  const machineBusy = phase === 'submitting'
  // 没有会话时整张卡变成「去选工作区」的触发器：DOM 是同一棵，只是不可编辑。
  const workspaceTrigger = inert && onRequestWorkspace !== undefined
  const editorDisabled = locked && !workspaceTrigger
  const editable = !locked && !machineBusy

  /*
    textarea 不会跟着内容长高，所以每次草稿变化都要量一遍：先把高度放回 auto（否则
    `scrollHeight` 会被上一次设进去的高度钉住，只长不缩），再按内容高度设回去。
    真正封顶的是外面的 `.scroll`（336px = 14 行 × 24px）。
  */
  useLayoutEffect(() => {
    const node = textRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(node.scrollHeight)}px`
    /*
      **光标在末尾时把滚动口推到底。** 浏览器那一次原生的「把光标滚进视野」发生在
      input 事件里，用的是**改高之前**的尺寸；等这个 effect 把新的一行长出来，那一行
      就落在 `.scroll` 的视野之外了，表现为打到第 15 行时字看不见。只在光标确实在
      末尾时才推——在中间编辑时高度一般不变，无条件推会把用户正在看的位置甩走。
    */
    const scroll = scrollRef.current
    if (scroll !== null && document.activeElement === node && node.selectionStart === draft.length) {
      scroll.scrollTop = scroll.scrollHeight
    }
  }, [draft])

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => { onDraftChange(e.target.value) }

  // 按钮按下会抢走焦点；在 mousedown 就拦掉，点完还能接着打字。
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => { e.preventDefault() }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 换行，⌘/Ctrl+Enter 发送：这里的内容常常是多行的。
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!empty && !locked && !machineBusy && !sendBlocked) onSubmit()
    }
  }

  // 没有会话时，那块不可编辑的文本面替代按钮充当选工作区的触发器（键盘用户也够得着）。
  const onWorkspaceKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!workspaceTrigger) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onRequestWorkspace()
    }
  }

  // 在跑、草稿又是空的：这颗钮此刻的意思是停止，不是发送。
  const primaryStops = running && empty
  const primaryDisabled = primaryStops ? stop === undefined : empty || locked || machineBusy || sendBlocked
  const primaryLabel = primaryStops ? stopLabel ?? sendLabel : sendLabel
  const interruptible = running && !primaryStops && stop !== undefined
  const onPrimary = (): void => {
    if (primaryStops) {
      stop?.()
      return
    }
    if (!empty && !locked && !machineBusy && !sendBlocked) onSubmit()
  }

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {notice !== null && (
        <div className={css.notice} role={notice.level === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}
      {/* 触发器状态下点击落在卡片上而不是文本面：工具条里禁用的控件会吞掉点击
          （CSS 把它们的 pointer-events 关了），所以**整个胶囊**才是那个拾取目标。 */}
      <div
        ref={cardRef}
        className={clsx(css.card, workspaceTrigger && css.cardWorkspaceTrigger)}
        data-composer-card
        onClick={workspaceTrigger ? onRequestWorkspace : undefined}
        onPointerDown={workspaceTrigger ? (e) => { e.stopPropagation() } : undefined}
      >
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {attachments}
        {/* 一个滚动口、一个文本面：文本面跟着内容长高，`.scroll`——CSS 里封在 14 行——
            是唯一会滚的东西。 */}
        <div ref={scrollRef} className={css.scroll} data-input-scroll>
          <div className={css.grow}>
            <textarea
              ref={textRef}
              className={clsx(css.input, editorDisabled && css.inputDisabled)}
              data-phase={phase}
              aria-disabled={editorDisabled || undefined}
              data-placeholder={placeholder}
              // 上游那块 contenteditable 的可读名字靠 aria-label 补（div 的 data-* 不是名字）；
              // textarea 本可以用原生 placeholder，但那会和下面那层 `.placeholder` 画两遍。
              aria-label={placeholder}
              aria-haspopup={workspaceTrigger ? 'menu' : undefined}
              aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
              value={draft}
              readOnly={!editable}
              rows={1}
              onChange={onChange}
              onKeyDown={workspaceTrigger ? onWorkspaceKeyDown : onKeyDown}
              style={{ resize: 'none', overflow: 'hidden' }}
            />
            {draft === '' && (
              <div aria-hidden className={css.placeholder} data-composer-placeholder>
                {placeholder}
              </div>
            )}
          </div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            {toggleCommandMenu !== undefined && (
              <button
                type="button"
                className={css.add}
                aria-label={commandsLabel}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                disabled={locked}
                onMouseDown={keepFocus}
                onClick={toggleCommandMenu}
              >
                <IconPlusOutline16 size={14} />
              </button>
            )}
            <div className={css.modes}>{modes}</div>
            {leading}
          </div>
          <div className={css.trailing}>
            {trailing}
            {modelSeat}
            {contextMeter}
            {interruptible && (
              <button
                type="button"
                className={css.primary}
                aria-label={stopLabel ?? sendLabel}
                onMouseDown={keepFocus}
                onClick={stop}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={css.primary}
              aria-label={primaryLabel}
              disabled={primaryDisabled}
              onMouseDown={keepFocus}
              onClick={onPrimary}
            >
              {primaryStops ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {variant === 'composer' ? dock : null}
    </div>
  )
})
