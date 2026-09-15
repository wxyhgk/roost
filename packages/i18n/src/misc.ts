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
    /* 左栏用搬来的那套壳和行（vendor/dsh/sidebar）需要的文案。 */
    sidebar: {
      newConversation: "新建对话",
      newConversationLabel: "新建对话",
      toggleOpen: "展开侧栏",
      toggleCollapse: "收起侧栏",
      panels: "面板",
      section: "对话",
      /** 「还有 n 条」——每组默认先露 5 条。 */
      more: (hidden: number) => `还有 ${hidden} 条`,
      collapse: "收起",
      /** 转录有缺口的那条对话，状态点是琥珀色。读屏要读得出来。 */
      gap: "这条对话的记录有缺口",
      /*
        相对时间。上游的 `relativeTime()` 只给桶和数量，文字由这里拼——
        **紧凑到能塞进 32px 行的尾巴**，所以是「12min」不是「12 分钟前」。
      */
      when: {
        now: "刚刚",
        minutes: (n: number) => `${n} 分`,
        hours: (n: number) => `${n} 时`,
        days: (n: number) => `${n} 天`,
        months: (n: number) => `${n} 月`,
        years: (n: number) => `${n} 年`,
      },
    },
    title: "对话",
    catalogEntry: (count: number) => `历史对话 ${count} 条`,
    catalogEntryPlain: "历史对话",
    catalogTitle: "历史对话",
    close: "关闭",
    search: "搜索标题或正文…",
    clearSearch: "清除搜索",
    empty: "还没有已保存的对话",
    /** 对话模式下中栏没有选中对话时的那一句。 */
    columnEmpty: "在左栏选一条对话；还没有的话，去终端里和 AI 说一句",
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
      /*
        上下文注入行（vendor/dsh/chat/ContextInjectionRow + ContextBody + SystemPromptRow）。
        「这次对话模型实际看到了什么」——系统提示词、环境快照、技能目录、被编辑过的文件。

        **`relayFrom` / `recallCounts` / `recallTruncated` 这三条画不出来。** 那两档（转发、召回）
        我们喂不满：`queued_command` 只有后台任务 id 不是会话 id，`compact_file_reference` 给不出
        「保留/省略几条」的计数——而那个计数正是那张卡存在的理由。文案留着是因为
        `ContextBodyLabels` 是个闭合接口，少一条就给不出一份全覆盖的 labels；和
        `turnTime.speed/ttft` 是同一个先例。
      */
      context: {
        injection: "上下文注入",
        recall: "上下文召回",
        systemPrompt: "系统提示词",
        systemPromptUpdate: "系统提示词（已更新）",
        unknownBlock: "未识别的内容块",
        jsonTruncated: (total: number) => `已截断，共 ${total} 字符`,
        /** 指令文件的四种状态。`added` / `updated` / `removed` 今天画不出来——Claude 只在开场铺一次底。 */
        instructions: {
          loaded: "开场载入",
          added: "新增",
          updated: "已更新",
          removed: "已移除",
        },
        catalogReplaced: "替换先前的目录",
        catalogMore: (count: number) => `另有 ${count} 条未列出`,
        snapshotSupersedes: "取代先前的快照",
        relayFrom: (session: string) => `转发自会话 ${session}`,
        recallCounts: (retained: number, omitted: number) => `保留 ${retained} 条，省略 ${omitted} 条`,
        recallTruncated: "这一路召回被截断过",
      },
      back: "返回列表",
      /** 头里那条面包屑的无障碍名。上游同一个位叫 `session.hierarchy`。 */
      hierarchy: "对话位置",
      /** 头右上角那颗 `…`：对话的属性与管理动作。 */
      details: "对话详情",
      /** 栏太窄时把动作/工具收进来的那颗钮。一样都不删，只是换个地方点。 */
      more: "更多",
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
      compacted: "上下文已压缩",
      /** 收起时标题右边那句。上游放「压缩了 N 条 · 约 M tokens」，那两个数我们算不出来。 */
      compactedDetail: "点开看摘要",
      /** AI 的思考过程：折叠行，收起时只看第一行。它是过程不是结论。 */
      thinking: "思考",
      thinkingRunning: "正在思考",
      /** 消息尾部那行图标：复制、时刻。分支我们还没实现，但组件里那条路留着。 */
      copy: "复制",
      copied: "已复制",
      branch: "从这里分支",
      branchUnavailable: "这条不能分支",
      /** markdown 里脚注那一节的标题。 */
      footnotes: "脚注",
      /** 非当天的消息才显示日期：同年只给月日，跨年才给年份。 */
      clockMd: (m: number, d: number) => `${m} 月 ${d} 日`,
      clockYmd: (y: number, m: number, d: number) => `${y} 年 ${m} 月 ${d} 日`,
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
      /*
        回合用量 / 回合耗时两个药丸和它们的弹层（vendor/dsh/chat/TurnUsagePanel）。上游的 `t`
        是一个扁平 key 的 locale seat（`message.turnUsage.count` 这种），调用方把下面这些映射过去。

        **紧凑单位用 K/M，不用「万/亿」。** 中文里 12200 本该读作「1.22 万」，但 `formatTokens`
        的分档是写死的 1e3/1e6（`vendor/dsh/chat/token-format.ts`）——把模板换成「万」而不动函数，
        会让 12200 显示成「12.2万」，也就是 12 万，**差一个数量级的谎**。要换就得连函数一起改，
        而那不值得：token 数是技术量，K/M 是 CLI、API 文档、供应商控制台一致的写法，换成万/亿
        反而对不上用户在别处看到的数；精确值那一档还用三位一组的千分位（`groupSeparator`），
        四位一档的万/亿和它摆在同一个弹层里也自相矛盾。所以函数不动，中英两份都用 K/M。
      */
      turnUsage: {
        /** `{count}` 已经是格式化好的数（`517` / `12.2K`）。 */
        count: (count: string) => `${count} tokens`,
        /** 药丸上那句。 */
        consumed: (total: string) => `用了 ${total}`,
        title: "本轮用量",
        model: "模型",
        cacheHit: "缓存命中",
        /** 特意不写成「输入」：这一项是**没命中缓存的**那部分，缓存读写各有自己一行。 */
        input: "未缓存输入",
        cacheRead: "缓存读取",
        cacheWrite: "缓存写入",
        output: "输出",
        /** 思考是输出的子集，所以挂在「输出」那一行后面，而不是自己占一行。 */
        reasoning: (tokens: string) => `（含思考 ${tokens}）`,
      },
      turnTime: {
        title: "本轮耗时",
        duration: "总时长",
        /*
          速度和首 token 延迟这两行**当前画不出来**：transcript 里没有首 token 时刻，我们只给
          `runMs`，弹层里这两行有 `!== undefined` 的闸门。文案照样留着——`TurnStatTranslate`
          的键是个闭合联合，少一个调用方就没法给出一个全覆盖的 `t`；而为了省两句话去改抄来的
          组件，代价比留着大。
        */
        speed: "速度",
        ttft: "首 token 延迟",
      },
      /*
        输入卡下面那两颗**会话级**药丸（vendor/dsh/chat/StatsPills）。和上面那两颗回合级的
        是同一套皮、不同的统计边界。

        **四条计时文案当前一条都画不出来**，和 `turnTime.speed/ttft` 同一个理由：transcript
        里没有 step 开始时刻、没有首 token 时刻、工具调用和结果也没有配对时刻。仪表盘那颗
        药丸因此退化成一个不可点的静态读数（只剩「n 轮 m 步」），弹层不出现。文案照样留着
        ——`SessionStatTranslate` 的键是个闭合联合，少一个调用方就给不出全覆盖的 `t`。
      */
      sessionStats: {
        /** 药丸上那句。上游写作 `{turns} 轮 {steps} 步`。 */
        counts: (turns: number, steps: number) => `${turns} 轮 ${steps} 步`,
        /** `{percent}` 已经是格式化好的百分数（可能带小数，见 formatCacheHitPercent）。 */
        cacheHit: (percent: string) => `缓存命中 ${percent}%`,
        title: "会话统计",
        usageTitle: "Token 用量",
        llmTime: "模型用时",
        toolTime: "工具调用用时",
        ttft: "首 token 平均（TTFT）",
        speed: "输出速度（TPS）",
        /** 紧凑时长，和上面那三档不是一套：药丸弹层要的是 `45.2秒` / `2分42秒` 这种短形。 */
        compactSeconds: (seconds: number) => `${seconds}秒`,
        compactMinutes: (minutes: number, seconds: number) => `${minutes}分${seconds}秒`,
      },
      ranFor: (duration: string) => `耗时 ${duration}`,
      tokensPerSecond: (tps: string) => `${tps} tokens/秒`,
      number: {
        thousand: (value: string) => `${value}K`,
        million: (value: string) => `${value}M`,
        /** 精确值的千分位分隔符，不带参数。 */
        groupSeparator: ",",
      },
      /** 耗时三档。小单位已经在格式化函数里补过零，所以可能是字符串。 */
      duration: {
        seconds: (seconds: number | string) => `${seconds} 秒`,
        minutes: (minutes: number | string, seconds: number | string) => `${minutes} 分 ${seconds} 秒`,
        hours: (hours: number, minutes: number | string, seconds: number | string) =>
          `${hours} 小时 ${minutes} 分 ${seconds} 秒`,
      },
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
      runs: "运行记录",
      runsHint: "这些是已保存的历史观察，不代表现在还在运行。",
      runsEmpty: "没有已保存的运行记录",
      runActive: "记录为运行中",
      runEnded: "已结束",
      runUnknown: "结束时间未知",
      /** 发信。202 只代表已排队，不代表 CLI 收到了。 */
      send: {
        placeholder: "发消息给这个对话的 CLI…",
        send: "发送",
        sending: "提交中…",
        cancel: "取消",
        retry: "重试",
        tooLong: "内容超出 15 KiB 上限，请精简后再发",
        noRun: "这个对话没有在跑的终端，暂时无法投递",
        conflict: "同一个请求已用别的内容提交过；请改用新的一条",
        /** 各状态对使用者的含义。措辞刻意保守：宁可说不确定，也不谎报已送达。 */
        queued: "已排队，等待写入",
        queuedDraft: "终端输入框里还有草稿，暂不写入",
        queuedBusy: "CLI 正在处理上一轮，排队等待",
        queuedDialog: "终端里有待处理的选择框",
        queuedOther: (reason: string) => `暂时不能投递（${reason}）`,
        dispatching: "正在提交，等待回执",
        accepted: "CLI 已接收",
        acceptedHint: "已进入 CLI 的原生输入，不代表任务已完成。",
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
    },
    /* 面板模块自己还在下载时的占位。首次打开某个面板才会看到，之后模块已在内存里。 */
    loading: "正在打开…",
    expandLibrary: "展开资料库 ↗",
    library: "资料库",
    libraryKind: "资料类型",
    hint: "搜索、浏览和编辑 · Esc 收起",
    collapse: "收起资料库",
    /*
      右栏三档呈现的那排按钮。每一档的文案写的是**按下去会变成什么**，不是当前是什么——
      按钮上只有一个图标，说「现在是推挤」帮不上忙。
    */
    chrome: {
      toPush: "让中栏让出位置",
      toFloat: "浮在中栏上，不挤它",
      toFullscreen: "铺满整个工作区",
      exitFullscreen: "退出全屏",
      /* 窄框下只有全屏一档，退出全屏就只能是收起——按钮换个说法，别让人以为还有别的落点。 */
      exitFullscreenNarrow: "收起面板",
      collapse: "收起右侧面板",
    },
  },

  leftRail: {
    view: "左侧视图",
    expandSessions: "展开工作区栏",
    collapseSessions: "收起工作区栏",
    sessions: "工作区",
    conversations: "对话",
    /* 两颗按钮切的是整套三栏，不只是左栏，所以副标题要把另外两栏也说出来。 */
    conversationsTitle: "对话：目录 · 正文 · 终端",
    terminal: "终端",
    terminalTitle: "终端：工作区 · 终端画面 · 文件",
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
      /** 只在对话模式下出现：那时终端住在右栏。 */
      terminal: "终端",
    },
    view: "右侧视图",
  },

  quiet: {
    title: (n: number, base: string) => `(提醒 ${n}) ${base}`,
    notifyTitle: (title: string) => `AI 本轮任务已完成：${title}`,
    notifyBody: (cwd: string) => `${cwd} · 可以回来查看结果了`,
  },

  /** 左栏那个角标：有几个会话在等你（AI 卡在权限上、或者跑完了你还没看）。 */
  inbox: {
    title: (count: number) => `${count} 个会话在等你`,
  },

    /**
     * 从 deepseek-harness 搬来的那批积木要的文案（vendor/dsh）。
     *
     * 单独一块而不是散进 detail：它们是**组件的契约**，不是我们自己的界面用语——
     * 上游改了 props，这一块跟着改；我们自己改措辞，不该碰到这里的结构。
     */
    blocks: {
      running: "正在运行",
      failed: "失败",
      stopped: "已中断",
      input: "输入",
      output: "输出",
      inspect: "查看",
      copy: "复制",
      copied: "已复制",
      collapse: "收起",
      collapseAria: "收起",
      expand: (hidden: number) => `还有 ${hidden} 行`,
      expandAria: (hidden: number) => `展开其余 ${hidden} 行`,
      files: (count: number) => `${count} 个文件`,
      /** 读文件：显示了多少行、一共多少行。 */
      window: (shown: number, total: number) => `${shown} / ${total} 行`,
      done: "完成",
      /** 跑完了但一个字都没输出——必须说出来，否则和「结果没拿到」长得一样。 */
      noOutput: "执行完成，没有输出",
      exitCode: (code: number) => `退出码 ${code}`,
      signal: (signal: string) => `信号 ${signal}`,
      noResults: "没有结果",
      truncated: "已截断",
      pathsSummary: (shown: number, total: number, truncated: boolean) =>
        `${shown} / ${total} 个文件${truncated ? "（已截断）" : ""}`,
      matchesSummary: (shown: number, total: number, files: number, truncated: boolean) =>
        `${shown} / ${total} 处匹配，${files} 个文件${truncated ? "（已截断）" : ""}`,
      sourcesTruncated: "来源已截断",
      http: "HTTP",
      contentTruncated: "内容已截断",
      /*
        `MessageItem` 那六句。**其中四句当前一条都画不出来**，照 `turnTime.speed/ttft`
        的先例留着：`MessageItemLabels` 是个闭合的接口，少一个键调用方就给不出一个
        全覆盖的对象，而为了省几句话去改抄来的组件，代价比留着大。

        画得出来的只有 extraBlock / jsonTruncated（用户消息里解析不出来的块）；
        turnError / authFailure / maxTokens / maxTokensHint 走的是 `error` 那个 prop，
        而我们的 transcript 里**没有回合级错误、也没有 stop_reason**——不传 `error`，
        那两行整块不渲染。**尤其不能把 maxTokens 那两句接上**：`TurnMaxTokensRow` 不吃
        任何数据、只吃文案，接上就是每条消息底下都能冒出一句「输出被截断」，那是言之
        凿凿的空壳（同 NOTICE 里 ask-question-row 不接的理由）。
      */
      extraBlock: "这条消息里还有一块没认出来的内容",
      jsonTruncated: (total: number) => `…（共 ${total} 字符，已截断）`,
      turnError: "本回合失败",
      authFailure: "登录已失效，请重新连接后再试。",
      maxTokens: "输出被截断",
      maxTokensHint: "这一回合到达了输出长度上限，后面的内容没有生成。",
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
