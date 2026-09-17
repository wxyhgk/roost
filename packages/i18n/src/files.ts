// files 域的界面文案。形状约定见 workspace.ts 顶部。
export const files = {
  preview: {
    saveFailed: "保存失败",
    editorFailed: "编辑器启动失败",
    editorError: (msg: string) => `编辑器启动失败: ${msg}`,
    discardConfirm: "放弃未保存的修改？",
    moveHint: "拖动移动, 双击复位",
    unsavedHint: "未保存的修改",
    done: "完成",
    edit: "编辑",
    unpin: "取消钉住(变回当前文件)",
    pin: "钉住(留在屏幕上, 可以接着打开别的文件)",
    close: "关闭",
    loadLatest: "载入最新",
    keepMine: "保留我的",
    conflict: "文件在别处被修改了。",
    tooLarge: "文件过大（超过 8 MiB），仅显示前面部分，无法编辑，以免保存不完整内容。",
    binary: "二进制文件",
    truncatedSuffix: "\n\n… 已截断",
    lines: (n: number) => `${n} 行`,
    chars: (s: string) => `${s} 字符`,
    truncated: "已截断",
    save: "保存",
    resizeHint: "拖动调整大小",
  },
    /** 化学分子编辑器（.mol / .sdf）。编辑器本体跑在同源 iframe 里。 */
    /** 把本机文件传进工作目录。契约见 tasks/file-upload-plan.md。 */
    upload: {
      button: "上传文件",
      dropHint: "松开即上传到当前目录",
      uploading: (name: string, percent: number) => `正在上传 ${name}（${percent}%）`,
      queued: (count: number) => `还有 ${count} 个排队`,
      cancel: "取消上传",
      tooLarge: (name: string) => `${name} 超过 64 MiB，无法上传`,
      /** 同名冲突：停下来问，因为覆盖不可撤销。 */
      conflictTitle: (name: string) => `${name} 已存在`,
      overwrite: "覆盖",
      rename: "自动改名",
      skip: "跳过",
      failed: (count: number) => (count === 1 ? "1 个文件上传失败" : `${count} 个文件上传失败`),
      dismiss: "知道了",
      /*
        文件夹拖进来之后的确认。**在遍历阶段问，不是传到一半才发现。**

        闸门按「要花多久」设，不按带宽：队列是串行的，一个文件一条请求，误拖一个
        node_modules 就是上万次顺序往返，本机也要几分钟。
      */
      confirmTitle: (files: number, size: string) => `要上传 ${files} 个文件（${size}）`,
      confirmHidden: (count: number) => `其中 ${count} 个是隐藏文件`,
      confirmTruncated: "内容太多，清单已截断，只会传其中一部分",
      confirmStart: "开始上传",
      confirmCancel: "不传了",
      creatingDirs: "正在创建目录…",
      dropHintFolder: "松开即上传，文件夹连同结构一起传",
      /** 悬在某个目录上时要说出**是哪个**——不然用户没法确认自己会传到哪儿。 */
      dropInto: (dir: string) => `松开即上传到 ${dir}`,
    },
    molecule: {
      dialogLabel: "化学分子编辑器",
      canvasLabel: "分子绘图区域",
      region: "分子编辑器",
      loading: "正在加载分子编辑器…",
      saved: "已保存",
      unsaved: "未保存",
      saving: "保存中…",
      save: "保存",
      handToAi: "交给 AI",
      closeLabel: "关闭分子编辑器",
      downloadDraft: "下载草稿",
      draftSuffix: "-draft",
      reload: "重新加载",
      reloadRemote: "重新读取远端",
      savingPreview: "已保存，正在生成并上传预览…",
      handedOff: "源文件和预览引用已插入终端，补充问题后发送。",
      multiRecord: (count: number) => `多结构 SDF（共 ${count} 条），仅编辑第一条，其余保存时原样保留。`,
      notPlainText: (format: string) => `文件不是完整的 ${format.toUpperCase()} 文本，无法编辑`,
      readFailed: "读取分子失败",
      loadFailed: "编辑器加载失败",
      /** 编辑器体量很大，网络不稳时最常见的失败就是资源没拉全。 */
      assetsFailed: "编辑器资源加载失败。它体积较大，网络不稳时容易中断——点「重新加载」重试。",
      slowLoad: "编辑器加载时间较长，请检查网络或点击重试。",
      actionFailed: "操作失败，请重试",
      conflict: "文件已被其他窗口修改。当前分子保留在编辑器中，可下载草稿或重新读取远端。",
      closeDirtyConfirm: "分子尚未保存，确定关闭并放弃修改？",
      reloadDirtyConfirm: "重新读取会丢弃当前未保存修改，确定继续？",
      /** 「交给 AI」这条链路上的文案。前四条会显示在错误条里。 */
      pathUnsupported: "文件路径包含不支持的字符",
      terminalNotReady: "分子已保存。终端尚未就绪，请连接后重试「交给 AI」。",
      connectionChanged: "分子已保存，但终端连接已变化。请在目标会话重试。",
      cliUnsupported: "分子已保存。当前终端未识别为支持图片的 AI CLI，可手动引用源文件。",
      notDelivered: "分子已保存，但引用未送达终端，请重试。",
      /** 这一句是**送进终端给 AI 读的**，不是界面文案，所以跟着用户语言走。 */
      reference: (path: string) => `分子源文件：${path}；结构预览：`,
      /** iframe 里连编辑器模块本身都没加载起来时，显示在 iframe 内的兜底。 */
      bootstrapFailed: (detail: string) => `编辑器加载失败：${detail}`,
    },
    markdown: {
      loading: "正在渲染…",
      renderFailed: "这份 Markdown 无法渲染，可切到编辑查看原文。",
    },

  browser: {
    noSession: "未选择会话",
    createFailed: "新建失败",
    modeLabel: "文件浏览模式",
    tree: "树形",
    list: "列表",
    pathLabel: "目录路径",
    upDir: "返回上级目录",
    filterList: "过滤当前目录…",
    filterTree: "过滤文件…",
    refresh: "刷新文件列表",
    watchStopped: "自动同步已停止，点击重新刷新并重试",
    create: "新建文件 / 文件夹 / 化学分子",
    /** 新建行离被右键的那个目录很远，不写出来就只能靠猜东西会落在哪。 */
    clearFilter: "清除过滤",
  },

  tree: {
    loading: "加载中…",
    /*
      等得比平常久时补的一句。

      「加载中」本身不说明任何事——慢链路上它是正常的，请求挂死时它也长这样，
      两者在界面上完全同形。这句话的作用是把「还在等」和「可以动手」分开：
      文字说明现在处于哪种情况，旁边的重试按钮给出不必干等的出路。
    */
    slow: "仍在加载…",
    slowHint: "比平常慢。网络较慢时正常，也可能是这次请求没有回来。",
    retry: "重试",
    empty: "空目录",
    noMatch: "无匹配文件",
    readDirFailed: "读取目录失败",
    readFileFailed: "读取文件失败",
    switchDirtyConfirm: "有未保存的修改，切换文件将丢弃，继续吗？",
    linkOutside: (path: string, cwd: string) =>
      `无法打开 ${path}：路径不在当前工作目录内，或不是可用的相对路径。当前目录：${cwd}`,
  },

  node: {
    expandFailed: "展开目录失败",
    renameFailed: "重命名失败",
    deleteDirConfirm: (path: string) => `删除目录 ${path} 及其全部内容？`,
    deleteFileConfirm: (path: string) => `删除文件 ${path}？`,
    deleteFailed: "删除失败",
    renameTitle: (name: string) => `重命名 ${name}`,
    deleteDirTitle: (name: string) => `删除目录 ${name}（含其中内容）`,
    deleteFileTitle: (name: string) => `删除文件 ${name}`,
  },

  menu: {
    copyFailed: "复制失败",
    insertFailed: "会话未连接，插入失败",
    copyPath: "复制相对路径",
    copyAbsolutePath: "复制绝对路径",
    copyContent: "复制文件内容",
    copyBinary: "二进制文件，内容无法复制",
    copyTruncated: "文件太大，只复制了开头 8 MiB",
    readFailed: "读取失败",
    insertToTerminal: "插入到终端",
    download: "下载",
    uploadHere: "上传到这里",
    newFile: "新建文件",
    newFolder: "新建文件夹",
    newMolecule: "新建分子",
    rename: "重命名",
    remove: "删除",
    refresh: "刷新",
  },
} as const;
