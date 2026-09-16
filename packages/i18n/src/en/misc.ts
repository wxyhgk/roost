// misc 域的界面文案。形状约定见 workspace.ts 顶部。
export const misc = {
  statusBar: {
    stableBuild: "Stable build",
    connected: "Connected",
    reconnecting: "Reconnecting",
    shellExited: "Shell exited",
    connecting: "Connecting",
    noSession: "No session selected",
  },

  /** stable.html 的启动壳，在主应用加载前就要能报错。 */
  bootstrap: {
    configFailed: "Failed to load workspace config",
    startFailed: "Startup failed",
    retry: "Retry",
  },

  session: {
    /** 会话没有自定义标题、cwd 也为空时的兜底名。 */
    fallbackTitle: "Terminal",
    coreUnavailable: (status: number) => `Terminal core unavailable (${status})`,
  },

  terminal: {
    inputNotSent: "The connection is not ready. Your input was not sent; please retype it after reconnecting.",
    dismissInputNotice: "Dismiss input notice",
    replayTooLarge: "The terminal screen exceeds the transfer limit. Automatic reconnection is paused; retry later.",
    replayUnavailable: "The terminal screen could not be restored. Automatic reconnection is paused; retry later.",
    viewInitFailed: (reason: string) => `Failed to initialize terminal view: ${reason}. Reload the view`,
    unknownError: "Unknown error",
    restartFailed: "Restart failed, try again",
    parserStuck: "Terminal output parsing has not finished after 10 seconds; check diagnostics or reload view",
    openLinkHint: (modifier: string, path: string, line: string) => `${modifier} + click to open · ${path}${line}`,
    lineSuffix: (line: number) => ` · line ${line}`,
  },

  request: {
    timeout: "Request timed out",
    offline: "Cannot connect to backend",
  },

  store: {
    connectRetry: "Cannot connect to backend, retrying",
    createSessionFailed: "Failed to create session",
    createProjectFailed: "Failed to create group",
    selectSessionFailed: "Failed to save selected session, restored",
    toggleProjectFailed: "Failed to save group expansion, restored",
    reorderFailed: "Failed to save order, restored",
    togglePinFailed: "Failed to save pin, restored",
    selectConversationFailed: "Could not save the conversation selection; reverted",
    followConversationFailed: "Could not save the follow setting; reverted",
    closeFailed: "Failed to save session hiding, restored",
    killFailed: "Failed to save session termination, restored",
    reopenFailed: "Failed to reopen session",
    renameSessionFailed: "Failed to save session rename, restored",
    saveNoteFailed: "Failed to save the note, restored",
    renameProjectFailed: "Failed to save group rename, restored",
    deleteProjectFailed: "Failed to save group deletion, restored",
  },

  /** 对话目录：独立于终端。终端关掉、CLI 退出，历史仍然留在这里可读。 */
  /** 登录。身份由 HttpOnly Cookie 承载，前端读不到也不该管理它。 */
  auth: {
    title: "Sign in",
    hint: "The password for this machine is in ~/.roost/auth-password (created on first start).",
    desktopTitle: "Local workspace",
    desktopConnecting: "Connecting…",
    desktopUnavailable: "The local connection is unavailable. Retry or reopen Roost. Running terminals are preserved.",
    password: "Password",
    submit: "Sign in",
    submitting: "Signing in…",
    wrong: "Wrong password",
    rateLimited: (seconds: number) => `Too many attempts. Try again in ${seconds}s`,
    /** configured=false：后端没配好认证，不是你没登录。这两件事必须分开说。 */
    unconfigured: "The backend has no authentication configured",
    unconfiguredHint: "There is no usable password file on the server, so protected endpoints return 503. This is a deployment issue; retrying will not help.",
    checking: "Checking sign-in status…",
    /** 会话到期：未提交的内容留在原地，不自动丢弃。 */
    expired: "Your session expired. Please sign in again",
    expiredHint: "Anything you had not submitted is still where you left it.",
    offline: "Cannot reach the backend",
    logout: "Sign out",
    logoutConfirm: "Signing out drops every live connection (terminal view, file watching, conversation sync). The terminal processes themselves are unaffected. Sign out?",
  },
  conversations: {
      newConversation: {
        label: "New conversation",
        hint: "Opens a terminal and starts the CLI. You can talk here once it reports in.",
        starting: "Starting…",
        failed: "Could not start that CLI",
        noCli: "No CLI is available yet. Configure one in settings.",
      },
    /** 跟随当前终端：只用 daemon 核验过的身份，绝不从历史列表猜。 */
    follow: {
      label: "Follow terminal",
      hint: "When on, switching terminals selects the conversation that terminal is running right now, verified by the daemon.",
      checking: "Verifying the current terminal…",
      /** 409：这个终端还没被识别出结构化对话。历史照常可读。 */
      noIdentity: "This terminal has no identified conversation yet",
      noIdentityHint: "What you are reading stays put. Nothing is guessed from past associations.",
      unavailable: "The identification service is unavailable",
      noTerminal: "No terminal selected",
    },
    title: "Conversations",
    catalogEntry: (count: number) => `${count} past conversations`,
    catalogEntryPlain: "Past conversations",
    catalogTitle: "Past conversations",
    close: "Close",
    search: "Search titles and messages…",
    clearSearch: "Clear search",
    empty: "No saved conversations yet",
    emptyHint: "Once you talk to an agent in a terminal, the conversation shows up here and stays after the terminal closes.",
    noMatch: "No conversations match",
    noMatchHint: "Try another term. Search covers both titles and message text.",
    loading: "Loading…",
    more: "Load more",
    retry: "Retry",
    /** 标题是 CLI 原生给的还是兜底生成的，影响可信度，值得标出来。 */
    fallbackTitle: "Auto-named",
    hasGap: "History incomplete",
    hasGapHint: "Part of this conversation could not be saved.",
    never: "No messages",
    /** 列表里的时间：同一天只显示时刻，日期部分对所有行都一样，是纯噪音。 */
    today: "Today",
    yesterday: "Yesterday",
    olderGroup: (date: string) => date,
    /** 对话详情：只读历史。打开它不会启动任何 CLI。 */
    /** 详情里的元信息与管理操作。 */
    meta: {
      show: "Details",
      hide: "Hide",
      cli: "CLI",
      folder: "Working directory",
      conversationId: "Conversation ID",
      nativeId: "Native session ID",
      created: "Created",
      lastMessage: "Last message",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      rename: "Rename",
      renamePlaceholder: "Give this conversation a name",
      save: "Save",
      cancel: "Cancel",
      group: "Group",
      noGroup: "No group",
      pin: "Pin",
      unpin: "Unpin",
      /** 409：别处刚改过。拿服务端的当前值刷新，让用户在新值上重做。 */
      conflict: "This conversation just changed elsewhere; refreshed to the latest values, please confirm again",
      failed: "Could not save",
    },
    detail: {
      back: "Back to list",
      loading: "Loading the conversation…",
      loadOlder: "Load earlier messages",
      noMessages: "No saved messages in this conversation",
      /** run 非空表示还有终端在跑，可以跳过去；为空照常读历史。 */
      jumpToTerminal: "Go to terminal",
      readOnly: "Read-only history",
      readOnlyHint: "This shows saved content only. Opening a conversation never starts a CLI or resumes generation.",
      /** 覆盖率缺口必须说，不能把残缺记录展示成完整历史。 */
      gap: "Part of the history was not saved",
      gapDetail: (skipped: number) => `${skipped} records could not be saved, so this is not a complete record.`,
      resynced: "Reconnected and reloaded the history",
      disconnected: "Live sync disconnected",
      roleUser: "You",
      roleAssistant: "Agent",
      roleTool: "Tool",
      toolRan: (name: string) => name || "Tool call",
      toolFailed: "failed",
      toolDenied: "denied",
      toolNoResult: "no result",
      /** `/compact` 的摘要：一条分隔行，点开才看。它不是用户说的话。 */
      contextInjected: "Context injected",
      compacted: "Context compacted",
      /** 命令输出留尾部：报错和结论都在末尾。 */
      outputClipped: "Earlier output omitted",
      /** 「跑完了但没输出」和「结果没拿到」必须分得开。 */
      outputEmpty: "Finished with no output",
      patchFile: "Change",
      turnDiffFiles: (n: number) => `${n} changed ${n === 1 ? "file" : "files"} this turn`,
      turnDiffPartial: "(partial)",
      patchTruncated: "Change truncated",
      toolGroup: (n: number) => `${n} tool ${n === 1 ? "call" : "calls"}`,
      toolGroupRunning: "running",
      toolGroupError: "failed",
      toolArgs: "Arguments",
      toolResult: "Result",
      roleOther: (role: string) => `From ${role}`,
      preview: "Body not fully saved",
      /** 定位当前终端：只在用户明确点击时查询，daemon 现场核验。 */
      locate: "Locate terminal",
      locating: "Verifying…",
      /** 503：旧 daemon 不支持这个接口。这是「暂时定位不了」，不是「对话不存在」。 */
      locateUnavailable: "Cannot locate right now: the daemon is outdated or disconnected",
      locateNoRun: "No verifiable run at the moment",
      locateNoRunHint: "History stays readable. Nothing will start a CLI for you here.",
      locateTrashed: "This conversation is in the trash; restore it before locating",
      locateChanged: "The run moved; locate again",
      /** 运行轨迹：全部是过去的观察，不是在线状态。 */
      runs: "Run history",
      runsHint: "These are saved observations, not proof that anything is running now.",
      runsEmpty: "No saved runs",
      runActive: "Recorded as running",
      runEnded: "Ended",
      runUnknown: "End time unknown",
      /** 发信。202 只代表已排队，不代表 CLI 收到了。 */
      send: {
        placeholder: "Send a message to this conversation's CLI…",
        send: "Send",
        sending: "Submitting…",
        cancel: "Cancel",
        retry: "Retry",
        tooLong: "Longer than the 15 KiB limit — please shorten it",
        noRun: "This conversation has no running terminal, so it cannot be delivered yet",
        blocked: {
          statusOffline: "Not connected right now, so this terminal's state is unknown",
          terminalGone: "This terminal is gone, so nothing can be delivered to it",
          noCli: "No AI CLI is running in this terminal",
          noCliHint: "Start one under Terminal (claude, codex, …); sending works once it connects.",
          unbound: "A CLI is running, but it has not reported which conversation it is in",
          unboundHint: "Send a line in Terminal — the CLI only reports when a prompt is actually submitted; a bare Enter does not count. Needed again after the daemon restarts.",
          run: "Run this conversation",
          runHint: "Opens a new terminal and resumes the same session. The terminal and this view show the same thing.",
          runStarting: "Starting…",
          runFailed: "Could not start it",
          runUnsupported: "This CLI cannot be resumed by session id",
          runAlreadyRunning: "It is already running in another terminal",
        },
        conflict: "That request id was already used with different text; send a new one",
        /** 各状态对使用者的含义。措辞刻意保守：宁可说不确定，也不谎报已送达。 */
        queued: "Queued, waiting to be written",
        queuedDraft: "The terminal input still has a draft, so it is not written yet",
        queuedBusy: "The CLI is busy with the previous turn; waiting",
        queuedDialog: "The terminal has a dialog waiting for you",
        queuedReason: {
          disabled: "GUI sending is not enabled",
          disabledHint: "The daemon must start with ROOST_CLAUDE_GUI_SEND=1 to open this channel. The message stays queued; nothing is lost.",
          unsupportedVersion: "Writing has not been verified for this CLI version",
          unsupportedVersionHint: "Typing into a TUI requires knowing exactly how its screen looks; misreading it could mean typing into a dialog. Only verified versions are allowed.",
          unsupportedCli: "This CLI cannot be sent to from here yet",
          terminalExited: "That terminal has exited",
          recipientOffline: "This conversation has no running terminal right now",
          identityUnconfirmed: "The terminal's conversation is not confirmed yet",
          screenUnavailable: "The terminal's screen has not been observed yet",
          screenUnknown: "The terminal's current screen is unrecognized, so nothing is written",
          terminalInput: "You just typed in the terminal; waiting a moment",
          commandPending: "Another write is in flight; waiting",
          notSubmittable: "This message cannot be submitted to the CLI",
          conversationTrashed: "This conversation is in the trash",
          lifecycleUnavailable: "This CLI gives no reliable completion signal",
          transcriptUnavailable: "The session transcript file is unavailable",
          transportUnavailable: "The CLI's input channel is unavailable",
        },
        queuedOther: (reason: string) => `Cannot deliver yet (${reason})`,
        dispatching: "Submitting, waiting for the receipt",
        accepted: "The CLI received it",
        acceptedHint: "It reached the CLI's native input. That does not mean the task is done.",
        uncertain: "It may have been written, but there is no confirmation",
        uncertainHint: "The request is kept. It will not resend automatically — resending could submit the same text twice.",
        failed: "Delivery failed",
        cancelled: "Cancelled",
        goTerminal: "Handle in terminal",
      },
    },
  },
  selection: {
    /** 触屏选区：终端用 canvas 渲染，手指长按不会产生原生选区，只能自己建。 */
    touch: {
      enter: "Select text",
      exit: "Done",
      reset: "Restart",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed — long-press the text below to copy by hand",
      hintAnchor: "Tap where the selection starts",
      hintFocus: "Tap where it ends; tap again to adjust",
      hintRange: "Selected. Tap again to move the end",
    },
    defaultTitle: "Terminal snippet",
    saveIncomplete: "Save incomplete; draft kept. Retry or handle it in the library panel",
    sessionMissing: "Session not found, cannot save",
    saveAsPrompt: "Save as file (relative to session directory)",
    saveFailed: "Save failed",
    saveNote: "Save note",
    saveSnippet: "Save snippet",
    saveFile: "Save file",
    saved: "Saved",
  },

  shell: {
    regionLibraryFiles: "Library and files region",
    regionSettings: "Settings",
    regionPalette: "Quick switch",
    regionMolecule: "Molecule editor",
  },

  errorBoundary: {
    /** 区域级错误边界：region 是已翻译的区域名。 */
    unavailable: (region: string) => `${region} is unavailable:`,
    retry: "Retry",
  },

  rightPanel: {
    titles: {
      files: "Files",
      notes: "Notes",
      snippets: "Snippets",
    },
    loading: "Opening…",
    expandLibrary: "Expand library ↗",
    library: "Library",
    libraryKind: "Library type",
    hint: "Search, browse, and edit · Esc to collapse",
    collapse: "Collapse library",
  },

  leftRail: {
    view: "Left views",
    expandSessions: "Expand the workspace sidebar",
    collapseSessions: "Collapse the workspace sidebar",
    sessions: "Workspaces",
    catalog: "Past conversations",
    catalogTitle: "Browse past conversations",
    settings: "Settings",
    settingsTitle: "Settings (⌘,)",
  },

  rightRail: {
    titles: {
      files: "Files",
      notes: "Notes",
      snippets: "Snippets",
    },
    view: "Right view",
  },

  quiet: {
    title: (n: number, base: string) => `(notifications ${n}) ${base}`,
    notifyTitle: (title: string) => `AI turn completed: ${title}`,
    notifyBody: (cwd: string) => `${cwd} · Ready to review`,
  },

  /** 左栏那个角标：有几个会话在等你（AI 卡在权限上、或者跑完了你还没看）。 */
  inbox: {
    title: (count: number) => `${count} session${count === 1 ? "" : "s"} waiting for you`,
  },

  media: {
    imageFailed: "Failed to load image",
    binary: "Binary file",
  },

  xyz: {
    loading: "Loading molecule preview…",
    resetTitle: "Reset view (double-click canvas too)",
    reset: "Reset",
    viewerError: "Molecule view error",
  },
} as const;
