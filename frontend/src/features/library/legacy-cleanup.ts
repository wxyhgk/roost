// Legacy browser collections were explicitly discarded when switching to the API.
// Do not remove API-backed editing drafts or the current library identity.
//
// 这里的键名**停在 diy- 上不动**：它们是旧版本写进浏览器的，永远不会有 roost- 版本。
// 跟着项目改名一起改掉的话，这个函数就再也找不到要删的东西了。
export function discardLegacyLibrary(storage: Storage) {
  for (const key of ["diy-notes-v1", "diy-library-legacy-backup-v1", "diy-library-source-v1"]) storage.removeItem(key);
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith("diy-library-import:")) storage.removeItem(key);
  }
}

/**
 * 把 localStorage 里剩下的 `roost-` 前缀键改名成 `roost-`。
 *
 * 项目改名那一刻，浏览器里已经存着的键还是旧名字。其中真正算数据的只有一样——
 * library 的编辑草稿（`roost-library-draft:*`），丢了就是丢掉没存盘的写作。主题和
 * last-id 丢了无所谓，但整体搬比挑着搬更不容易漏，也省得下次又发现一个。
 *
 * **必须在 discardLegacyLibrary 之后跑**：那个函数按旧名字删遗留垃圾，先改名的话
 * 它就找不着了，垃圾反而被搬进新命名空间。
 *
 * 也必须在任何人读 localStorage 之前跑——LibraryClient 的构造函数就会读 last-id，
 * 所以 runtime 是在模块作用域调用这两个的，不在 startLibraryRuntime 里。
 *
 * 这是一次性的搬运，等所有用过的浏览器都搬完就可以删。
 */
export function adoptRoostKeys(storage: Storage) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (!key?.startsWith("diy-")) continue;
    const renamed = `roost-${key.slice("diy-".length)}`;
    // 新键已经有值就别覆盖：那是搬完之后写进去的，比旧的新。
    if (storage.getItem(renamed) === null) storage.setItem(renamed, storage.getItem(key) ?? "");
    storage.removeItem(key);
  }
}
