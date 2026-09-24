import { plural } from "./plural";
// 界面文案集中处。
//
// 现在只解决「文案散落」：同一概念多种说法无法审阅、改文案要全仓 grep、
// code review 里看不见这次动了哪些用户可见文字。**还不是国际化**——真要英文时
// 把这个对象换成 zh/en 两份并加一个 useT()，调用点形状不变（见 tasks/i18n-proposal.md）。
//
// 约定：
//  1. 按功能域嵌套，不用扁平 key。调用点 t.session.kill 自解释，且有类型补全。
//  2. 带参数的写成函数而不是占位符模板：类型安全，不需要运行时格式化器，
//     换语言时只换函数体。
//  3. 普通模块导出，不是 hook——store、api 这些非 React 模块也要能用。
//  4. 之所以是独立包而不是 frontend/src 下的一个文件：check-boundaries 规定
//     library/ 只能相对引用 library/ 内部，放在 src 下它就够不着，而 library/client.ts
//     是中文字面量密度第二高的文件。包引用不受那条规则约束。

export const workspace = {
  common: {
    copied: "Copied",
    cancel: "Cancel",
  },

  session: {
    note: "Note",
    noteAdd: "Add a note",
    noteEdit: "Edit note",
    notePlaceholder: "What is this terminal for?",
    noteHint: "⌘↵ to save · Esc to cancel",
    noteTooLong: (max: number) => `A note is at most ${max} characters`,
    conversationId: "Conversation ID",
    more: "More actions",
    rename: "Rename session",
    renameHintDouble: "Double-click to rename",
    renameHintClick: "Click to rename",
    pin: "Pin session",
    unpin: "Unpin",
    pinned: "Pinned",
    copyId: "Copy session id",
    copyIdDone: "Copied",
    copyResume: "Copy resume command",
    copyResumeDone: "Command copied",
    copyCwd: "Copy working directory",
    copyCwdDone: "Working directory copied",
    kill: "End session",
    killConfirm: {
      title: "End this session?",
      detail: "The process will be terminated and cannot be recovered",
      confirm: "End session",
    },
    unread: "New terminal output not viewed",

    /** 传输连不上后端，与「shell 已退出」是两回事。 */
      offline: "Backend unreachable",
      offlineHint: "Retrying in the background every 30 seconds — it reconnects on its own once the backend is back.",
      screenUnavailable: "Screen could not be restored",
      retry: "Retry now",

    /** agent 自报的状态。与「终端有没有输出」是两回事，文案要分得开。 */
    /** 结构化 AI 会话的只读同步面板。 */
    aiSync: {
      title: "AI session",
      /** 会话尚未被识别成结构化会话——这不是故障。 */
      unbound: "No structured session detected yet",
      unboundHint: "This terminal has not reported a structured AI session yet. The terminal itself works normally; syncing starts on its own once the agent reports its identity.",
      empty: "Connected, no messages yet",
      emptyHint: "Ask the agent something in the terminal and the exchange will appear here.",
      noMessages: "No message content yet",
      noMessagesHint: "Only state changes have arrived so far. Message content syncs once a turn actually starts.",
      noSession: "Select a terminal session first",
      connecting: "Connecting…",
      /** 我们这条连接断了，已经拿到的内容仍然展示。 */
      disconnected: "Sync disconnected, reconnecting",
      disconnectedHint: "Below is what arrived before the disconnect. It will not update.",
      /** 顶部状态条。 */
      readOnly: "Read-only sync",
      readOnlyHint: "This panel only mirrors what was synced. To reply or approve, go back to the terminal.",
      /** 降级提示。 */
      realtimeOnly: "Real-time sync only",
      realtimeOnlyHint: "The current daemon cannot replay missed events, so anything produced while disconnected cannot be recovered.",
      gap: "Part of the history could not be recovered",
      gapHint: "A stretch of history is genuinely missing, and reconnecting will not bring it back. What follows is not a complete record.",
      errorDaemon: "Daemon connection unavailable",
      errorSource: "Source read or persistence failed",
      errorRebind: "A different AI session identity appeared",
      errorRebindHint: "This terminal switched to another native session. Rebinding is not offered in this round, so sync stays on the current one.",
      /** 会话状态。offline 表示连接或身份未确认，不等于任务失败。 */
      states: {
        binding: "Confirming identity",
        ready: "Ready",
        running: "Agent is working",
        waiting: "Waiting on you",
        completed: "Turn finished",
        failed: "Turn failed",
        offline: "Connection or identity unconfirmed",
      },
      offlineHint: "The connection or identity is unconfirmed. This does not mean the task failed.",
      /** 消息与条目。 */
      /** AI 回复默认折叠：整段铺开会把「你问了什么」淹掉。 */
      expand: (lines: number) => `Show all ${lines} lines`,
      collapse: "Collapse",
      roleUser: "You",
      roleAssistant: "Agent",
      roleOther: (role: string) => `From ${role}`,
      waitingTitle: "Waiting on you",
      waitingPermission: "The agent needs your approval to continue",
      waitingQuestion: "The agent asked you a question",
      waitingWhere: "Respond in the terminal. This panel only displays; it has no approve button.",
      toolLine: (tool: string, input: string) => `${tool}: ${input}`,
      errorEntry: "An error occurred during sync",
      /** 底部元信息。 */
      cliLabel: (cli: string) => `CLI ${cli}`,
      nativeLabel: (id: string) => `Native session ${id}`,
      lastReceived: (when: string) => `Last received: ${when}`,
      neverReceived: "Nothing received yet",
    },

    agent: {
      needsPermission: "Agent needs your approval",
      needsAnswer: "Agent is waiting for your answer",
      working: "Agent is working",
      done: "Agent finished",
      failed: "Agent failed",
      /** 系统通知：AI 停下来等你，这是唯一需要你立刻回来的状态。 */
      notifyTitle: (title: string) => `Waiting on you: ${title}`,
      notifyPermission: "The agent needs your approval to continue",
      notifyQuestion: "The agent asked you a question",
      /** agent 没给整句 summary 时的兜底：用工具名和入参自己拼一句。 */
      notifyTool: (tool: string, input: string) => `Agent wants to run ${tool}: ${input}`,
      notifyToolOnly: (tool: string) => `Agent wants to run ${tool}`,
      /** 角标提示：「在等你批准」这一类 + agent 说的具体那件事。 */
      blockedWithDetail: (kind: string, detail: string) => `${kind}: ${detail}`,
    },

    /** agent 自报的任务清单。右侧面板那一栏。 */
    tasks: {
      noSession: "No terminal selected",
      noSessionHint: "Open a terminal and its agent's task list shows up here.",
      empty: "No task list yet",
      emptyHint: "Once the agent lays out its tasks in this session they appear here, and they do not scroll away with the terminal.",
      progress: (done: number, total: number) => `${done} / ${total} done`,
      status: {
        pending: "To do",
        in_progress: "In progress",
        completed: "Done",
      },
    },

    /** 终端活动状态。键与 session-status 的 ActivityView.state 一一对应。 */
    activity: {
      active: "Terminal has output",
      quiet: "No new output",
      exited: "Exited",
      closed: "Closed",
      unavailable: "Status unavailable",
      connecting: "Connecting status",
      disconnected: "Status connection lost",
      unknown: "No terminal status",
    },

    quiet: {
      seconds: (n: number) => `Quiet ${n}s`,
      minutes: (n: number) => `Quiet ${n}m`,
      hours: (h: number) => `Quiet ${h}h`,
      hoursMinutes: (h: number, m: number) => `Quiet ${h}h ${m}m`,
      /** 后端重启后观测记录为空，说「未知」比伪装成「刚刚」诚实。 */
      unknownHint: "Last output time unknown: no output has been observed for this session since the backend restarted",
      hint: "Time since the last terminal output; does not mean the AI has finished or is waiting for confirmation",
    },
  },

  sidebar: {
    title: "Workspaces",
    count: (n: number) => `${n} ${plural(n, "terminal", "terminals")}`,
    allTerminals: "All terminals",
    ungrouped: "Ungrouped",
    newWorkspace: "New workspace",
    /** 空工作区的第一句话，同时解释了「分组不开终端」这个容易误解的地方。 */
    empty: "Click ＋ to open a new terminal; creating a workspace only organizes.",
    dragHint: "Drag a card from the canvas onto a workspace to file it there.",
    /** 一个工作区里所有终端合起来的状态，取最需要你的那个。 */
    expand: (name: string) => `Expand ${name}`,
    collapse: (name: string) => `Collapse ${name}`,
    noTerminals: "No terminals here yet",
    groupActivity: {
      blocked: "An AI is waiting for you",
      active: "A terminal is producing output",
      quiet: "No new output",
      none: "No terminals yet",
    },
  },

  project: {
    rename: "Rename group",
    delete: "Delete group, keep sessions",
    deleteConfirm: (name: string) => `Delete group "${name}"? Sessions will be moved to ungrouped.`,
  },

  newMenu: {
    trigger: "New",
    terminal: "Terminal",
    project: "New group",
    reopenHeading: "Reopen session",
  },

  topBar: {
    breadcrumb: "Location",
    /** ⌘K 原来只有热键、界面上没有入口，等于不存在。 */
    commandPalette: "Quick switch (⌘K)",
    expandSessions: "Expand session sidebar",
    collapseSessions: "Collapse session sidebar (⌘B)",
    expandRight: "Expand right sidebar",
    collapseRight: "Collapse right sidebar (⌘J)",
    toLightTheme: "Switch to light theme",
    toDarkTheme: "Switch to dark theme",
    /** 没有选中会话时的面包屑兜底。 */
    noSession: "No session selected",
  },

  palette: {
    label: "Quick switch",
    placeholder: "Switch sessions, files, notes, snippets…",
    clear: "Clear",
    noResults: "No matching results",
    loading: "Loading…",
    retry: "Retry",
    /** 「加载更多」按分区标签拼后缀，如「加载更多笔记」。英文里标签降为小写，Load more notes。 */
    more: (label: string) => `Load more ${label.toLowerCase()}`,
    /** 隐藏会话的标记与动作提示。 */
    hidden: "Hidden · press Enter to reopen",
    current: "Current",
    footer: {
      select: "↑↓ Select",
      jump: "Enter Jump",
      close: "Esc Close",
    },
    sections: {
      sessions: "Sessions",
      files: "Files",
      /** 有工作目录时在「文件」后面缀上目录名。 */
      filesIn: (dir: string) => `Files · ${dir}`,
      notes: "Notes",
      snippets: "Snippets",
    },
    hints: {
      needSession: "Select a session first",
      typeToSearch: "Type to search current directory",
    },
    /** 笔记/片段没有标题时的占位。 */
    untitledNote: "Empty note",
    untitledSnippet: "Untitled snippet",
  },
} as const;
