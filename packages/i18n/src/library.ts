// library 域的界面文案。形状约定见 workspace.ts 顶部。
export const library = {
  /** 草稿保存状态机的展示文案。键是状态标识（frontend 的 SaveState），值是显示文字。
      状态比较一律用键，不能用值——切语言后值会变。 */
  saveState: {
    unsaved: "未保存",
    saving: "保存中",
    saved: "已保存",
    failed: "失败",
    conflict: "冲突",
  },

  error: {
    connection: "连接失败，草稿已保留，请重试",
    invalidData: "服务器返回了无效数据",
    fallback: "操作失败，请重试",
    libraryChanged: "资料库已改变，请先导出当前草稿并重新加载页面",
    storageUnavailable: "浏览器存储不可用",
    backupFailed: "本地草稿备份失败，请保持页面打开并导出草稿",
    draftEditing: "这条资料已有正在编辑的草稿，请先处理或另存",
    remoteDeleted: "远端已删除，本地草稿已保留",
    remoteChanged: "服务器版本已变化，本地草稿已保留",
    serverBusy: "服务器暂时无法保存，草稿已保留，请重试",
    updatedElsewhere: "资料已在其他窗口更新，本地草稿已保留",
    deleteBlocked: "请先保存或处理草稿冲突，再删除资料",
  },
} as const;
