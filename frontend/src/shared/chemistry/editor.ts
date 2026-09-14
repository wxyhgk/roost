/**
 * **2D 结构编辑器的契约。** 和 viewer.ts 是一对：那边管「看」，这边管「画」。
 *
 * 边界的重点在 `formats`：编辑器**自己声明**能读写哪些格式，调用方据此决定哪些文件归它
 * 管、下载时用什么 MIME、界面上怎么称呼它。在此之前这件事是反过来的——格式是一个写死的
 * 联合类型 `'mol' | 'sdf'`，而 `/\.(mol|sdf)$/i` 这条正则又在另一个文件里各写一遍。两处
 * 都是在替 Ketcher 做声明，换一个能读 SMILES 或 CDXML 的编辑器就得同时改两处，而且改漏
 * 一处的症状是「文件打不开」，不会有任何类型错误。
 */

export type MoleculeFormat = {
  /** 传给编辑器的格式 id。 */
  id: string;
  /** 认哪些扩展名（不带点，小写）。第一个用作下载时的扩展名。 */
  extensions: string[];
  /** 下载时的 MIME。 */
  mediaType: string;
};

/**
 * 编辑器的活画布。
 *
 * 只有三件事：给它内容、把内容要回来、要一张图。**没有 `molfile()`**——那是在说
 * 「你必须能吐 MDL molfile」，而那是 Ketcher 的能力，不是「一个结构编辑器」的定义。
 * 需要图的地方要的本来就是图（交给终端里的 AI 看），中间那道格式转换是实现的事。
 */
export type MoleculeCanvas = {
  load(content: string, format: string): Promise<void>;
  /** 按载入时的格式回写。 */
  save(): Promise<string>;
  /** 画布当前内容的位图。 */
  image(): Promise<Blob>;
};

/**
 * 路径归哪个格式管，没有就是 null（这个编辑器不该碰这个文件）。
 *
 * 按最后一个点之后的部分比，大小写不敏感。没有点的文件名一律不算——否则一个叫 `mol`
 * 的文件会被当成 molfile。
 */
export function formatFor(path: string, formats: readonly MoleculeFormat[]): MoleculeFormat | null {
  const name = path.replaceAll("\\", "/").split("/").at(-1)!;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return formats.find(f => f.extensions.includes(ext)) ?? null;
}
