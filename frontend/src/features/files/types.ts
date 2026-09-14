/**
 * 文件树对外和对内共用的那几个类型。
 *
 * **单独一个模块，是为了不让类型把模块图拧成环。** `NewEntryRow` 要 `NewKind`，
 * 而 `TreeNode` 要渲染 `NewEntryRow`——类型长在 TreeNode 里的话，两个文件就互相
 * import 了。type-only import 构建时会被擦掉，所以运行时看不出问题，但
 * tests/module-graph.test.ts 会红，而且它红得对：环就是环，迟早有一次不是
 * type-only 的引用顺着它长出来。
 *
 * 和 `shared/view.ts`、`features/terminal/types.ts` 是同一个理由、同一种办法。
 */

/** 新建哪一种。mol 只是带扩展名兜底的 file，落到后端仍然是 file。 */
export type NewKind = "file" | "dir" | "mol";

export type FolderActions = {
  /** 把上传目标定到 `dir`，然后打开文件选择器。 */
  upload(dir: string): void;
  /** 就地在 `dir` 里插一行待命名的新条目，并把那个目录展开。 */
  create(dir: string, kind: NewKind): void;
};

/**
 * 正在等着命名的那个新条目。**它属于树，而不是面板顶部**——右键哪个目录，输入框就长在
 * 哪个目录里，落点和输入框不再是两处。`dir` 是空串表示落在树根上。
 */
export type PendingCreate = {
  dir: string;
  kind: NewKind;
  error: string | null;
  commit(name: string): void;
  cancel(): void;
};
