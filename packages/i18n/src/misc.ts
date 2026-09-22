// misc 域的界面文案。形状约定见 workspace.ts 顶部。
export const misc = {
  statusBar: {
    stableBuild: "稳定版",
    connected: "已连接",
    reconnecting: "重连中",
    shellExited: "Shell 已退出",
    connecting: "连接中",
    noSession: "未选择会话",
  },

  /** stable.html 的启动壳，在主应用加载前就要能报错。 */
  bootstrap: {
    configFailed: "工作台配置加载失败",
    startFailed: "启动失败",
    retry: "重试",
  },

  session: {
    /** 会话没有自定义标题、cwd 也为空时的兜底名。 */
    fallbackTitle: "终端",
    coreUnavailable: (status: number) => `终端基座不可用 (${status})`,
  },

  terminal: {
    inputNotSent: "连接未就绪，刚才的输入未发送。恢复后请重新输入。",
    dismissInputNotice: "关闭输入提示",
    replayTooLarge: "终端画面超过传输上限，自动重连已暂停。可稍后重试。",
    replayUnavailable: "暂时无法恢复终端画面，自动重连已暂停。可稍后重试。",
    viewInitFailed: (reason: string) => `终端视图初始化失败：${reason}，请重新加载视图`,
    unknownError: "未知错误",
    restartFailed: "重启失败，请重试",
    parserStuck: "终端输出解析超过 10 秒未完成，可查看诊断或重新加载视图",
    openLinkHint: (modifier: string, path: string, line: string) => `${modifier} + 点击打开 · ${path}${line}`,
    lineSuffix: (line: number) => ` · 第 ${line} 行`,
  },

  request: {
    timeout: "请求超时",
    offline: "无法连接后端",
  },

  store: {
    connectRetry: "无法连接后端，正在重试",
    createSessionFailed: "新建会话失败",
    createProjectFailed: "新建分组失败",
    selectSessionFailed: "选中会话保存失败，已恢复",
    toggleProjectFailed: "分组展开保存失败，已恢复",
    reorderFailed: "排序保存失败，已恢复",
    togglePinFailed: "置顶保存失败，已恢复",
    selectConversationFailed: "对话选择保存失败，已恢复",
    followConversationFailed: "跟随设置保存失败，已恢复",
    closeFailed: "隐藏会话保存失败，已恢复",
    killFailed: "结束会话保存失败，已恢复",
    reopenFailed: "重新打开会话失败",
    renameSessionFailed: "重命名会话保存失败，已恢复",
    saveNoteFailed: "备注保存失败，已恢复",
    renameProjectFailed: "重命名分组保存失败，已恢复",
    deleteProjectFailed: "删除分组保存失败，已恢复",
  },

  /** 对话目录：独立于终端。终端关掉、CLI 退出，历史仍然留在这里可读。 */
  /** 登录。身份由 HttpOnly Cookie 承载，前端读不到也不该管理它。 */
  auth: {
    title: "登录",
    hint: "这台机器上的密码保存在 ~/.roost/auth-password（首次启动自动生成）。",
    desktopTitle: "本机工作区",
    desktopConnecting: "正在连接…",
    desktopUnavailable: "本机连接暂时不可用。请重试，或重新打开 Roost。正在运行的终端会保留。",
    password: "密码",
    submit: "登录",
    submitting: "正在登录…",
    wrong: "密码不对",
    rateLimited: (seconds: number) => `尝试过于频繁，请 ${seconds} 秒后再试`,
    /** configured=false：后端没配好认证，不是你没登录。这两件事必须分开说。 */
    unconfigured: "后端未配置认证",
    unconfiguredHint: "服务端没有可用的密码文件，受保护的接口会返回 503。这是部署问题，重试登录没有用。",
    checking: "正在检查登录状态…",
    /** 会话到期：未提交的内容留在原地，不自动丢弃。 */
    expired: "登录已过期，请重新登录",
    expiredHint: "你没有提交的内容仍然保留在原来的位置。",
    offline: "无法连接后端",
    logout: "退出登录",
    logoutConfirm: "退出会断开所有实时连接（终端画面、文件监听、对话同步）。终端进程本身不受影响。确定退出？",
  },
  conversations: {
      /** 从 GUI 直接开一条新对话：起一个 CLI，身份等它自己报。 */
      newConversation: {
        label: "新建对话",
        hint: "开一个新终端把 CLI 起起来。它报到之后这里就能说话了。",
        starting: "正在启动…",
        failed: "没能启动这个 CLI",
        noCli: "还没有可用的 CLI。到设置里配一个。",
      },
    /** 跟随当前终端：只用 daemon 核验过的身份，绝不从历史列表猜。 */
    follow: {
      label: "跟随终端",
      hint: "打开后，切换终端会自动选中该终端此刻正在跑的对话。身份由 daemon 现场核验。",
      checking: "正在核验当前终端…",
      /** 409：这个终端还没被识别出结构化对话。历史照常可读。 */
      noIdentity: "当前终端还没有可识别的对话",
      noIdentityHint: "正在看的历史保持不变。不会从历史记录里猜一条当作当前身份。",
      unavailable: "识别服务不可用",
      noTerminal: "没有选中的终端",
    },
    title: "对话",
    catalogEntry: (count: number) => `历史对话 ${count} 条`,
    catalogEntryPlain: "历史对话",
    catalogTitle: "历史对话",
    close: "关闭",
    search: "搜索标题或正文…",
    clearSearch: "清除搜索",
    empty: "还没有已保存的对话",
    emptyHint: "在终端里用 AI 聊过之后，对话会自动出现在这里，终端关掉也不会消失。",
    noMatch: "没有匹配的对话",
    noMatchHint: "换个关键词试试。搜索会同时找标题和正文。",
    loading: "正在加载…",
    more: "加载更多",
    retry: "重试",
    /** 标题是 CLI 原生给的还是兜底生成的，影响可信度，值得标出来。 */
    fallbackTitle: "自动命名",
    hasGap: "历史不完整",
    hasGapHint: "这段对话有一部分没能保存下来。",
    never: "无消息",
    /** 列表里的时间：同一天只显示时刻，日期部分对所有行都一样，是纯噪音。 */
    today: "今天",
    yesterday: "昨天",
    olderGroup: (date: string) => date,
    /** 对话详情：只读历史。打开它不会启动任何 CLI。 */
    /** 详情里的元信息与管理操作。 */
    meta: {
      show: "详细信息",
      hide: "收起",
      cli: "CLI",
      folder: "工作目录",
      conversationId: "对话 ID",
      nativeId: "原生会话 ID",
      created: "创建于",
      lastMessage: "最后消息",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败",
      rename: "改标题",
      renamePlaceholder: "给这条对话起个名字",
      save: "保存",
      cancel: "取消",
      group: "分组",
      noGroup: "不分组",
      pin: "置顶",
      unpin: "取消置顶",
      /** 409：别处刚改过。拿服务端的当前值刷新，让用户在新值上重做。 */
      conflict: "这条对话刚被改过，已刷新为最新值，请重新确认",
      failed: "保存失败",
    },
    detail: {
      back: "返回列表",
      loading: "正在加载对话…",
      loadOlder: "加载更早的消息",
      noMessages: "这段对话没有已保存的消息",
      /** run 非空表示还有终端在跑，可以跳过去；为空照常读历史。 */
      jumpToTerminal: "跳到终端",
      readOnly: "只读历史",
      readOnlyHint: "这里只展示已保存的内容。打开对话不会启动 CLI，也不会继续生成。",
      /** 覆盖率缺口必须说，不能把残缺记录展示成完整历史。 */
      gap: "部分历史未能保存",
      gapDetail: (skipped: number) => `有 ${skipped} 条记录没能保存下来，下面不是完整记录。`,
      resynced: "连接已重建，历史已重新载入",
      disconnected: "实时同步已断开",
      roleUser: "你",
      roleAssistant: "AI",
      roleTool: "工具",
      /** 工具调用折叠成一行；参数和结果展开才看。 */
      toolRan: (name: string) => name || "工具调用",
      toolFailed: "失败",
      /** 「没跑」不是「跑失败」：被拒绝的调用一个字节都没执行，标成失败是在报一个没发生的错。 */
      toolDenied: "已拒绝",
      toolNoResult: "没有结果",
      /** `/compact` 的摘要：一条分隔行，点开才看。它不是用户说的话。 */
      /* 注入进模型的上下文。行上折起来，点开看全文。 */
      contextInjected: "注入的上下文",
      compacted: "上下文已压缩",
      /** 命令输出留尾部：报错和结论都在末尾。 */
      outputClipped: "上面还有更早的输出，已省略",
      /** 「跑完了但没输出」和「结果没拿到」必须分得开。 */
      outputEmpty: "执行完成，没有输出",
      /** 折叠成组时的摘要。 */
      /** 文件改动：直接显示 diff，不折叠——那是用户最关心的结果。 */
      patchFile: "改动",
      /** 一个回合的改动汇总。截断过就只是下界，必须说出来。 */
      turnDiffFiles: (n: number) => `本轮改动 ${n} 个文件`,
      turnDiffPartial: "（不完整）",
      patchTruncated: "改动过长，已截断",
      toolGroup: (n: number) => `${n} 次工具调用`,
      toolGroupRunning: "进行中",
      toolGroupError: "有失败",
      toolArgs: "参数",
      toolResult: "结果",
      roleOther: (role: string) => `来自 ${role}`,
      preview: "正文未完整保存",
      /** 定位当前终端：只在用户明确点击时查询，daemon 现场核验。 */
      locate: "定位终端",
      locating: "正在核验…",
      /** 503：旧 daemon 不支持这个接口。这是「暂时定位不了」，不是「对话不存在」。 */
      locateUnavailable: "暂时无法定位：daemon 尚未升级或已断开",
      locateNoRun: "当前没有可核验的运行",
      locateNoRunHint: "历史照常可读。这里不会替你新开 CLI。",
      locateTrashed: "对话在回收站里，恢复后才能定位",
      locateChanged: "运行位置已变化，请重新定位",
      /** 运行轨迹：全部是过去的观察，不是在线状态。 */
      /** 发信。202 只代表已排队，不代表 CLI 收到了。 */
      send: {
        placeholder: "发消息给这个对话的 CLI…",
        send: "发送",
        sending: "提交中…",
        cancel: "取消",
        retry: "重试",
        tooLong: "内容超出 15 KiB 上限，请精简后再发",
        noRun: "这个对话没有在跑的终端，暂时无法投递",
        /**
         * 发不出去的几种成因，判据见 `frontend/src/features/conversations/sendability.ts`。
         * 分开写是因为**做法不同**：一条要你去启动 CLI，一条只要你在 TUI 里敲一下，
         * 还有一条根本不是故障。合成一句「没有在跑的终端」时它们全都无解。
         */
        blocked: {
          statusOffline: "连接还没恢复，暂时判断不了这个终端的状态",
          terminalGone: "这个终端已经不在了，没法再投递",
          noCli: "这个终端里没有在跑的 AI CLI",
          noCliHint: "先在「终端」里启动一个（claude、codex 等），它接上后这里就能发消息。",
          unbound: "CLI 在跑，但还没报出它在哪个对话里",
          /**
           * **这句话原来是错的，而且把人引向一个不会生效的动作。**
           *
           * 原文是「到终端里发一句话——CLI 只在真的提交了一条 prompt 时才上报」。前半句的
           * 事实没错（CLI 确实只在提交时上报），但它隐含的结论不成立：**上报了也没用**。
           * 绑定记的是 PTY 进程的实例号，而事件在到达绑定之前就被「实例号不符」丢掉了
           * （backend/src/ai-agent-source.ts）。实测：一个终端一整天 168 条事件，绑定一动没动。
           *
           * 真正管用的是把绑定挪到当前这条进程上——那正是旁边那个按钮做的事。
           */
          unboundHint: "绑定还指着这个终端上一次的进程。在终端里继续打字不会自己恢复——用旁边的「重新绑定」把它挪过来。",
          /**
           * 「把这条对话跑起来」。这是「只能看不能说」的正解：输入框要的是一条 active 的
           * run，而 run 只在 CLI 报到之后才有——所以不猜绑定，直接把 CLI 拉起来。
           */
          /**
           * 「重新绑定」。
           *
           * `unbound` 那格原来只给一句「到终端里发一句话」，而那条路**做不到**：事件在到达
           * 绑定之前就被「PTY 实例号不符」丢掉了，在终端里继续打字并不会让它自愈。
           * 实测过：一个终端一整天 168 条事件，绑定一动没动。
           */
          rebind: "重新绑定",
          rebinding: "正在重新绑定…",
          rebindHint: "把绑定挪到当前这条终端进程上。身份仍由 CLI 自己报出的记录确认，认不出就不改。",
          rebindUnconfirmed: "在这条终端的记录里没认出对话身份，绑定没有改动",
          rebindConflict: "这条对话已经绑在别的终端上了",
          rebindFailed: "重新绑定失败",
          run: "把这条对话跑起来",
          runHint: "新开一个终端，用同一条会话接着跑。终端和这里看到的是同一份。",
          runStarting: "正在启动…",
          runFailed: "没能启动",
          runUnsupported: "这个 CLI 不支持按会话 id 恢复",
          runAlreadyRunning: "它已经在另一个终端里跑着了",
        },
        conflict: "同一个请求已用别的内容提交过；请改用新的一条",
        /** 各状态对使用者的含义。措辞刻意保守：宁可说不确定，也不谎报已送达。 */
        queued: "已排队，等待写入",
        queuedDraft: "终端输入框里还有草稿，暂不写入",
        queuedBusy: "CLI 正在处理上一轮，排队等待",
        queuedDialog: "终端里有待处理的选择框",
        /**
         * 排队原因的人话。原来只认 3 种，其余一律掉进 `queuedOther`，于是用户看到的是
         * 「暂时不能投递（disabled）」这种把内部标识原样漏出来的句子——既看不懂，也不
         * 知道该干什么。这些原因来自 `ai-command-owner.ts` 的 `reason()` 和
         * `peer-delivery.ts` 的 pump，是个封闭集合，值得逐条给说法。
         *
         * `pending` **不在这里**：它是插入 peer_deliveries 时钉的初始值，意思是「刚入队，
         * daemon 还没轮到」，根本不是一个阻塞原因。把它当理由显示是错的，见下面的 `queued`。
         */
        queuedReason: {
          disabled: "GUI 发送没有开启",
          disabledHint: "daemon 要带着 ROOST_CLAUDE_GUI_SEND=1 启动才会开这条通道。这条消息会一直排着，不会丢。",
          unsupportedVersion: "这个 CLI 版本还没验证过写入",
          unsupportedVersionHint: "往 TUI 里写字要先确认它的屏幕长什么样，认错了可能敲在选择框上。所以只对验证过的版本开放。",
          unsupportedCli: "这个 CLI 还不支持从这里发送",
          terminalExited: "那个终端已经退出了",
          recipientOffline: "这个对话现在没有在跑的终端",
          identityUnconfirmed: "还没确认这个终端在哪条对话里",
          screenUnavailable: "还没看到终端的画面",
          screenUnknown: "认不出终端现在的画面，不敢往里写",
          /**
           * 前台归属：写进去的字节会被谁收到。CLI 起了 vim（`git commit`）或 less 时，
           * 键盘归那个程序——而 vim 的 normal mode 下正文本身就是命令，所以这一格必须
           * 一个字节都不写。
           */
          foregroundNotCli: "终端里现在是别的程序在前台",
          foregroundNotCliHint: "CLI 可能开了编辑器或分页器（比如 git commit 打开的 vim）。等它回到 CLI，这条会自己发出去。",
          foregroundUnknown: "判断不了终端前台是什么，先不写",
          terminalInput: "你刚在终端里敲过字，稍等一下",
          commandPending: "前面还有一条在写，排队等待",
          notSubmittable: "这条消息没法提交给 CLI",
          conversationTrashed: "这个对话在回收站里",
          lifecycleUnavailable: "这个 CLI 没给出可靠的完成信号",
          transcriptUnavailable: "拿不到这个会话的转录文件",
          transportUnavailable: "拿不到这个 CLI 的输入通道",
        },
        queuedOther: (reason: string) => `暂时不能投递（${reason}）`,
        dispatching: "正在提交，等待回执",
        /*
          TUI 输入框的镜像。

          GUI 的输入框和 TUI 的输入框是同一个东西的两个视图，GUI 这一份是给人看的。
          看不见对面写着什么，「发送」就退化成往一个看不见的地方投递——回执、不确定态、
          重试那一整套语义都是为那种投递准备的。看得见之后它们大半不需要解释。

          `unknown` 和 `empty` **必须分开说**：前者是「我们瞎了」，后者是「对面确实是空的」。
          混成一句会让用户在我们看不见的时候以为一切正常。
        */
        tui: {
          label: "终端输入框",
          empty: "空着",
          unknown: "认不出终端现在的画面",
          ready: "可以写入",
          typing: "你正在终端里打字",
        },
        /*
          认领之后、写进去之前，这条消息可能在门口等很久（CLI 正忙、终端里有选择框、
          前台是别的程序）。上面那句话一个字都没说在等什么，实测有一条等了八分钟。
          原因用的是排队那一套词表——**同一个封闭集合**，没必要再造一份。
          前缀「已提交」是要紧的：这一格不能取消了，措辞不能让人以为还能撤。
        */
        dispatchingBlocked: (reason: string) => `已提交，${reason}`,
        accepted: "CLI 已接收",
        acceptedHint: "已进入 CLI 的原生输入，不代表任务已完成。",
        /**
           * P2：正文放进了输入框，但我们**没有**替用户按回车。
           * 这不是故障，是刻意的——`\r` 的含义由接收方当时的画面决定，而认清画面只能靠
           * 认 TUI 长相的正则，正则又只在某个版本上验过。去掉那一下回车，这条因果链就断了。
           */
        awaitingUserSubmit: "已经放进终端的输入框，按回车发出",
        awaitingUserSubmitHint: "这个 CLI 版本我们还没实测过「自动提交」，所以只替你把字放进去，最后那一下由你按。按完这条会自己标成已送达。",
        uncertain: "可能已写入，但没有拿到确认",
        uncertainHint: "保留这条请求。不会自动重发——重发可能造成同一句话提交两次。",
        failed: "投递失败",
        cancelled: "已取消",
        goTerminal: "去终端处理",
      },
    },
  },
  selection: {
    /** 触屏选区：终端用 canvas 渲染，手指长按不会产生原生选区，只能自己建。 */
    touch: {
      enter: "选择文本",
      exit: "完成",
      reset: "重选",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败，可长按下方文本手动复制",
      hintAnchor: "点一下选择起点",
      hintFocus: "再点一下选择终点，可继续点调整",
      hintRange: "已选中，可继续点调整终点",
    },
    defaultTitle: "终端片段",
    saveIncomplete: "保存未完成，草稿已保留，可重试或在资料面板处理",
    sessionMissing: "会话不存在，无法保存",
    saveAsPrompt: "保存为文件（相对会话目录）",
    saveFailed: "保存失败",
    saveNote: "存笔记",
    saveSnippet: "存片段",
    saveFile: "存文件",
    saved: "已保存",
    /** 把选中的文本括号粘贴进 CLI 的输入框，用 ``` 包起来，**不替你按回车**。 */
    toCli: "粘到对话框",
    pasted: (lines: number) => `已粘 ${lines} 行到对话框`,
    /** 折叠型（opencode）：内容进去了，但它显示的是占位符，得说一声免得以为没成功。 */
    pastedCollapsed: (lines: number) => `已粘 ${lines} 行（对话框显示为折叠占位符）`,
    /** 没在真 PTY 里量过这家 CLI 的多行粘贴，不敢发——理由见 cli-adapters 的 multilinePaste。 */
    pasteUnmeasured: (cli: string) => `还没在 ${cli} 上验证过多行粘贴，先不发`,
    pasteNoCli: "没认出正在跑的 CLI，先不发",
    pasteFailed: "没发出去，检查连接",
  },

  /** 线上换了新版本，而这个页面还是旧的。**不自动刷**——用户可能正在终端里打字。 */
  newBuild: {
    message: "已发布新版本",
    action: "重新载入",
    dismiss: "忽略",
  },
  shell: {
    regionLibraryFiles: "资料与文件区域",
    regionSettings: "设置",
    regionPalette: "快速切换",
    regionMolecule: "分子编辑器",
  },

  errorBoundary: {
    /** 区域级错误边界：region 是已翻译的区域名。 */
    unavailable: (region: string) => `${region}暂不可用：`,
    retry: "重试",
  },

  rightPanel: {
    titles: {
      files: "文件",
      notes: "笔记",
      snippets: "代码片段",
      tasks: "任务",
    },
    /* 面板模块自己还在下载时的占位。首次打开某个面板才会看到，之后模块已在内存里。 */
    loading: "正在打开…",
    expandLibrary: "展开资料库 ↗",
    library: "资料库",
    libraryKind: "资料类型",
    hint: "搜索、浏览和编辑 · Esc 收起",
    collapse: "收起资料库",
  },

  leftRail: {
    view: "左侧视图",
    expandSessions: "展开工作区栏",
    collapseSessions: "收起工作区栏",
    sessions: "工作区",
    catalog: "历史对话",
    catalogTitle: "翻看历史对话",
    settings: "设置",
    settingsTitle: "设置 (⌘,)",
  },

  rightRail: {
    titles: {
      files: "文件",
      notes: "笔记",
      snippets: "代码片段",
      tasks: "任务清单",
    },
    view: "右侧视图",
  },

  quiet: {
    title: (n: number, base: string) => `(提醒 ${n}) ${base}`,
    notifyTitle: (title: string) => `AI 本轮任务已完成：${title}`,
    notifyBody: (cwd: string) => `${cwd} · 可以回来查看结果了`,
  },

  media: {
    imageFailed: "图片加载失败",
    binary: "二进制文件",
  },

  xyz: {
    loading: "正在加载分子预览…",
    resetTitle: "重置视角(双击画布也可)",
    reset: "复位",
    // 不写「3Dmol error」：查看器是要换的，用户可见的文案不该点它的名。
    viewerError: "分子视图出错",
  },
} as const;
