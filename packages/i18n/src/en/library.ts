// library 域的界面文案。形状约定见 workspace.ts 顶部。
export const library = {
  /** 草稿保存状态机的展示文案。键是状态标识（frontend 的 SaveState），值是显示文字。
      状态比较一律用键，不能用值——切语言后值会变。 */
  saveState: {
    unsaved: "Unsaved",
    saving: "Saving",
    saved: "Saved",
    failed: "Failed",
    conflict: "Conflict",
  },

  error: {
    connection: "Connection failed, your draft was kept, please retry",
    invalidData: "The server returned invalid data",
    fallback: "Operation failed, please retry",
    libraryChanged: "The library has changed, please export your current draft and reload the page",
    storageUnavailable: "Browser storage is unavailable",
    backupFailed: "Local draft backup failed, please keep the page open and export your draft",
    draftEditing: "This item already has a draft being edited, please finish it or save it as a copy first",
    remoteDeleted: "Deleted on the remote, your local draft was kept",
    remoteChanged: "The server version has changed, your local draft was kept",
    serverBusy: "The server cannot save right now, your draft was kept, please retry",
    updatedElsewhere: "This item was updated in another window, your local draft was kept",
    deleteBlocked: "Please save or resolve the draft conflict before deleting this item",
  },
} as const;
