// terminal 域的界面文案。形状约定见 workspace.ts 顶部。
export const terminal = {
  diagnostics: {
    toggle: "诊断 / 恢复",
    title: "终端诊断",
    closeLabel: "关闭终端诊断",
    phaseLabel: "当前阶段",
    phaseFallback: "准备中",
    phase: {
      layout: "等待布局",
      connecting: "连接中",
      handshake: "握手中",
      replay: "解析回放",
      live: "可交互",
      exited: "Shell 已退出",
      error: "视图加载失败",
    },
    historyLabel: "历史回放",
    historyTruncated: "较早历史超出保留范围",
    historyOk: "未报告截断",
    gridSize: (cols: number, rows: number) => `${cols} 列 / ${rows} 行`,
    gridLabel: "终端行列",
    /** 「内容在缓冲里却没显示」有三种成因，这两行是用来分清它们的。 */
    viewportLabel: "视口位置",
    viewportAt: (y: number, base: number) => y >= base ? `已到底 (${y})` : `停在上方 ${base - y} 行 (${y}/${base})`,
    fitsLabel: "容器可容纳 / 实际",
    fitsRows: (fits: number | null, rows: number) => fits === null ? `— / ${rows} 行` : `${fits} / ${rows} 行${fits < rows ? "（被裁掉）" : ""}`,
    widthLabel: "画面宽度 / 容器",
    widthFits: (painted: number | null, box: number) => painted === null ? `— / ${box}px` : `${painted} / ${box}px${painted > box ? "（右边被裁）" : ""}`,
    cursorLabel: "输出游标（已解析 / 已收）",
    queueLabel: "解析队列 / 画面冻结",
    yes: "是",
    no: "否",
    restore: "恢复画面",
    reload: "重新加载视图",
    copy: "复制诊断",
    repainted: "已解冻并整屏重绘",
    reconnecting: "正在重新接入原终端",
    reconnected: "已重新接入原终端",
    copied: "诊断已复制",
    copyFailed: "复制失败，请重试",
    noteRetain: "恢复画面保留当前缓冲区：解冻、整屏重绘，并把终端尺寸抖一下逼 CLI 自己重画——**全屏 TUI 会因此把当前这一屏重新打印一遍**，这是让它重画的唯一办法。重新加载会重建显示并接回原 Shell，不重启进程；较早历史受服务端保留范围限制。",
    notePrivacy: "诊断只包含状态、尺寸和时间，不包含命令或输出正文。",
  },


  /** 中间栏的画布：一屏卡片，点进去才是真终端。 */
  canvas: {
    title: "终端",
    count: (n: number) => `${n} 个`,
    open: (title: string) => `打开 ${title}`,
    back: "返回画布",
    newSession: "新建终端",
  },

  /** 中间栏的两个视角：TUI 是终端本身，GUI 是同一段对话的可读形态。 */
  lens: {
    tui: "终端",
    gui: "对话",
    switchToGui: "切换到对话视图",
    switchToTui: "切换到终端",
    resolving: "正在确认当前对话…",
    /** 没有可识别的对话时不显示切换器，这条只在明确查询失败时用。 */
    noConversation: "这个终端还没有可识别的对话",
  },
    /** 「这个终端里在跑什么」面板：AI 起的后台服务和它们的端口。 */
    processes: {
      title: "这个终端里在跑的",
      noSession: "先选一个终端",
      full: "完整命令",
      refresh: "刷新",
      loading: "查看中…",
      empty: "这个终端里没有在跑的后台进程",
      unsupported: "这个平台看不到终端的进程归属",
      hint: "按控制终端归属。用 setsid 或标准 daemon 化脱离出去的进程看不到；nohup 起的仍然看得到。",
    },

  pane: {
    title: "终端",
    search: "在终端中查找 (⌘F)",
    exportLog: "导出终端日志",
    searchPlaceholder: "在终端中查找…",
    notFound: "未找到",
    prev: "上一个",
    next: "下一个",
    closeSearch: "关闭查找",
    emptyTitle: "新建会话以打开终端",
    emptyHint: "分组不会启动终端",
    expandLeft: "展开会话栏",
    expandRight: "展开文件栏",
  },

  view: {
    notConnected: "会话未连接，插入失败",
    historyNotice: "较早历史超出保留范围，当前终端可继续使用",
    dismissHistory: "关闭历史恢复提示",
    reconnecting: "重连中…",
    exited: "Shell 已退出",
    restarting: "正在启动…",
    restart: "重新启动终端",
    /** 多个观众共用一个 PTY：尺寸只有一个赢家，先让用户知道另一头有人。 */
    othersWatching: (labels: string) => `另有 ${labels} 在看同一个终端`,
    resume: (cli: string) => `恢复 ${cli} 对话`,
    resumeHint: (command: string) => `重启这个终端并执行 ${command}，接着上一段对话`,
    /** 运行中的第一下 Ctrl+C 被当成「清空输入」吃掉了，告诉人怎么才是真打断。 */
    /** 有文件拖在终端上方时的提示。说清楚松手会发生什么，而不是「拖放到这里」。 */
    dropImage: "松手把图片交给这个终端里的 AI CLI",
    interruptArmed: "已清空输入 · 再按一次 Ctrl+C 打断模型",
    pendingImageAlt: "待发送图片",
    insertImage: "插入图片",
    cancel: "取消",
    close: "关闭",
    jumpToBottom: "跳转到底部",
  },

  /*
    手机上的终端按键栏。软键盘打不出 Esc，也打不出 Shift+Tab，没有这一栏在手机上连退出
    AI CLI 都退不出来。键面符号（Esc / ⇧⇥ / ↑ …）在 keys.ts 里当数据，不在这儿——
    那些是终端键的通用印刷，任何语言下都一样；这里只放读屏名称和按钮说明。
  */
  keyBar: {
    label: "终端按键",
    expand: "展开终端按键栏",
    collapse: "收起终端按键栏",
    /** 三态修饰键得说得出口，否则锁上了从界面上看不出来。 */
    modifierHint: "轻点只对下一个键生效，长按锁定",
    once: "生效一次",
    locked: "已锁定",
    keys: {
      esc: "Esc",
      shiftTab: "Shift+Tab",
      minus: "减号",
      home: "行首",
      up: "上",
      end: "行尾",
      pageUp: "上一页",
      tab: "Tab",
      ctrl: "Ctrl",
      alt: "Alt",
      left: "左",
      down: "下",
      right: "右",
      pageDown: "下一页",
    },
  },

  recovery: {
    checking: "正在检查可恢复的对话…",
    syncing: "对话信息正在同步。",
    unconfirmed: "暂时无法确认最近的对话，恢复已暂停。",
    unavailable: "暂时无法连接终端服务。",
    noConversation: "没有可恢复的对话。",
    unsupported: "此 CLI 暂不支持恢复对话。",
    unusable: "最近的对话缺少恢复信息。",
    failed: "暂时无法检查可恢复的对话。",
    autoRetry: "稍后自动重试。",
    retry: "重新检查",
    alreadyRunning: "终端已启动，正在重新连接…",
  },

  paste: {
    uploadFailed: (status: number, message: string) => `图片上传失败（${status}）：${message}`,
    connectionChanged: "终端连接已变化，请在目标终端重新粘贴图片。",
    inserted: "图片引用已插入，可继续输入说明。",
    oneAtATime: "每次请粘贴一张图片。",
    unsupportedType: "请粘贴 PNG、JPEG 或 WebP 图片。",
    tooLarge: "图片不能超过 10 MiB。",
    notConnected: "终端尚未连接，请连接后重新粘贴。",
    uploading: "正在上传图片…",
    noCli: "未识别到可接收图片的 CLI，请进入 AI CLI 后重新粘贴。",
    pathUnavailable: "图片路径不可用，请重新粘贴。",
    confirmInsert: (cli: string) => `图片已上传，插入 ${cli}？`,
    timeout: "图片上传超时，请重新粘贴。",
    uploadRetry: "图片上传失败，请重新粘贴。",
  },
} as const;
