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
    copied: "已复制",
    cancel: "取消",
  },

  session: {
    note: "备注",
    noteAdd: "添加备注",
    noteEdit: "编辑备注",
    notePlaceholder: "这个终端是干嘛的？",
    noteHint: "⌘↵ 保存 · Esc 取消",
    noteTooLong: (max: number) => `备注最多 ${max} 个字符`,
    conversationId: "对话 ID",
    more: "更多操作",
    rename: "重命名会话",
    pin: "置顶会话",
    unpin: "取消置顶",
    pinned: "已置顶",
    copyCwd: "复制工作目录",
    copyCwdDone: "已复制工作目录",
    kill: "结束会话",
    killConfirm: {
      title: "结束该会话？",
      detail: "进程将被终止，不可恢复",
      confirm: "结束会话",
    },
    unread: "有新终端输出未查看",

    /** 传输连不上后端，与「shell 已退出」是两回事。 */
      offline: "连不上后端",
      offlineHint: "自动重连已停止，检查后端是否在运行",
      retry: "重试连接",

    /** agent 自报的状态。与「终端有没有输出」是两回事，文案要分得开。 */
    /** 结构化 AI 会话的只读同步面板。 */
    aiSync: {
      title: "AI 会话",
      /** 会话尚未被识别成结构化会话——这不是故障。 */
      unbound: "尚未识别结构化会话",
      unboundHint: "这个终端还没有报告结构化的 AI 会话身份。普通终端功能不受影响，正常使用即可；一旦 AI 报告身份，这里会自动开始同步。",
      empty: "已连接，暂时还没有消息",
      emptyHint: "在终端里向 AI 提问，往来内容会同步到这里。",
      noMessages: "还没有消息正文",
      noMessagesHint: "到目前为止只收到了状态变化。往来正文要等这一轮真正开始才会同步过来。",
      noSession: "先选一个终端会话",
      connecting: "正在连接…",
      /** 我们这条连接断了，已经拿到的内容仍然展示。 */
      disconnected: "同步已断开，正在重连",
      disconnectedHint: "下面是断开之前已经收到的内容，它不会再更新。",
      /** 顶部状态条。 */
      readOnly: "只读同步",
      readOnlyHint: "这里只展示同步过来的内容。要回复 AI、批准操作，请回到终端里操作。",
      /** 降级提示。 */
      realtimeOnly: "当前仅支持实时同步",
      realtimeOnlyHint: "当前 daemon 不支持补收，断开期间产生的内容无法补回。",
      gap: "部分历史未能恢复",
      gapHint: "有一段历史确实缺失了，重连也不会让它回来。下面展示的不是完整记录。",
      errorDaemon: "daemon 连接不可用",
      errorSource: "来源读取或持久化失败",
      errorRebind: "发现了另一个 AI 会话身份",
      errorRebindHint: "这个终端里换了一个原生会话。本轮不提供换绑，同步会停在当前这一份上。",
      /** 会话状态。offline 表示连接或身份未确认，不等于任务失败。 */
      states: {
        binding: "正在确认身份",
        ready: "已就绪",
        running: "AI 正在处理",
        waiting: "等待你的回应",
        completed: "本轮已完成",
        failed: "本轮执行失败",
        offline: "连接或身份未确认",
      },
      offlineHint: "连接或身份未确认，不代表任务失败。",
      /** 消息与条目。 */
      /** AI 回复默认折叠：整段铺开会把「你问了什么」淹掉。 */
      expand: (lines: number) => `展开全部 ${lines} 行`,
      collapse: "收起",
      roleUser: "你",
      roleAssistant: "AI",
      roleOther: (role: string) => `来自 ${role}`,
      waitingTitle: "等待你的回应",
      waitingPermission: "AI 需要你批准才能继续",
      waitingQuestion: "AI 有问题在等你回答",
      waitingWhere: "请到终端里回应。这里只做展示，不提供批准按钮。",
      toolLine: (tool: string, input: string) => `${tool}：${input}`,
      errorEntry: "同步过程中出现错误",
      /** 底部元信息。 */
      cliLabel: (cli: string) => `CLI ${cli}`,
      nativeLabel: (id: string) => `原生会话 ${id}`,
      lastReceived: (when: string) => `最近收到：${when}`,
      neverReceived: "尚未收到任何内容",
    },

    agent: {
      needsPermission: "AI 在等你批准",
      needsAnswer: "AI 在等你回答",
      working: "AI 正在工作",
      done: "AI 已完成",
      failed: "AI 执行失败",
      /** 系统通知：AI 停下来等你，这是唯一需要你立刻回来的状态。 */
      notifyTitle: (title: string) => `等你回应：${title}`,
      notifyPermission: "AI 需要你批准才能继续",
      notifyQuestion: "AI 有问题在等你回答",
      /** agent 没给整句 summary 时的兜底：用工具名和入参自己拼一句。 */
      notifyTool: (tool: string, input: string) => `AI 要执行 ${tool}：${input}`,
      notifyToolOnly: (tool: string) => `AI 要执行 ${tool}`,
      /** 角标提示：「在等你批准」这一类 + agent 说的具体那件事。 */
      blockedWithDetail: (kind: string, detail: string) => `${kind}：${detail}`,
    },

    /** agent 自报的任务清单。右侧面板那一栏。 */
    tasks: {
      noSession: "没有选中的终端",
      noSessionHint: "先进一个终端，这里显示它里面 agent 的任务清单。",
      empty: "还没有任务清单",
      emptyHint: "agent 在这个会话里列出任务之后，会出现在这里，而且不会随终端滚走。",
      progress: (done: number, total: number) => `${done} / ${total} 已完成`,
      status: {
        pending: "待办",
        in_progress: "进行中",
        completed: "已完成",
      },
    },

    /** 终端活动状态。键与 session-status 的 ActivityView.state 一一对应。 */
    activity: {
      active: "终端有输出",
      quiet: "暂无新输出",
      exited: "已退出",
      closed: "已关闭",
      unavailable: "状态暂不可用",
      connecting: "状态连接中",
      disconnected: "状态连接中断",
      unknown: "暂无终端状态",
    },

    quiet: {
      seconds: (n: number) => `静默 ${n} 秒`,
      minutes: (n: number) => `静默 ${n} 分钟`,
      hours: (h: number) => `静默 ${h} 小时`,
      hoursMinutes: (h: number, m: number) => `静默 ${h} 小时 ${m} 分`,
      /** 后端重启后观测记录为空，说「未知」比伪装成「刚刚」诚实。 */
      unknownHint: "上次输出时间未知：后端重启后还没观测到这个会话的输出",
      hint: "距上次终端输出的时间，不代表 AI 已完成或在等待确认",
    },
  },

  sidebar: {
    title: "工作区",
    count: (n: number) => `${n} 个终端`,
    allTerminals: "全部终端",
    ungrouped: "未分组",
    newWorkspace: "新建工作区",
    /** 空工作区的第一句话，同时解释了「分组不开终端」这个容易误解的地方。 */
    empty: "点 ＋ 开新终端，新建工作区只是归类。",
    dragHint: "把画布上的卡片拖到工作区即可归类。",
    /** 一个工作区里所有终端合起来的状态，取最需要你的那个。 */
    expand: (name: string) => `展开 ${name}`,
    collapse: (name: string) => `收起 ${name}`,
    noTerminals: "这里还没有终端",
    groupActivity: {
      blocked: "有 AI 在等你",
      active: "有终端正在输出",
      quiet: "暂无新输出",
      none: "还没有终端",
    },
  },

  project: {
    rename: "重命名分组",
    delete: "删除分组，会话保留",
    deleteConfirm: (name: string) => `删除分组「${name}」？会话将移到未分组。`,
  },

  newMenu: {
    trigger: "新建",
    terminal: "终端",
    project: "新建分组",
    reopenHeading: "重新打开会话",
  },

  topBar: {
    breadcrumb: "当前位置",
    expandSessions: "展开会话栏",
    collapseSessions: "收起会话栏 (⌘B)",
    expandRight: "展开右侧栏",
    collapseRight: "收起右侧栏 (⌘J)",
    toLightTheme: "切换到浅色主题",
    toDarkTheme: "切换到深色主题",
    /** 没有选中会话时的面包屑兜底。 */
    noSession: "未选择会话",
  },

  palette: {
    label: "快速切换",
    placeholder: "切换会话、文件、笔记、片段…",
    clear: "清除",
    noResults: "无匹配结果",
    loading: "加载中…",
    retry: "重试",
    /** 「加载更多」按分区标签拼后缀，如「加载更多笔记」。 */
    more: (label: string) => `加载更多${label}`,
    /** 隐藏会话的标记与动作提示。 */
    hidden: "已隐藏 · 回车重开",
    current: "当前",
    footer: {
      select: "↑↓ 选择",
      jump: "回车 跳转",
      close: "Esc 关闭",
    },
    sections: {
      sessions: "会话",
      files: "文件",
      /** 有工作目录时在「文件」后面缀上目录名。 */
      filesIn: (dir: string) => `文件 · ${dir}`,
      notes: "笔记",
      snippets: "代码片段",
    },
    hints: {
      needSession: "先选一个会话",
      typeToSearch: "输入搜索当前目录",
    },
    /** 笔记/片段没有标题时的占位。 */
    untitledNote: "空笔记",
    untitledSnippet: "未命名片段",
  },
} as const;
