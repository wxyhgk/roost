/**
 * XYZ 的解析和**归一化**。单独一个模块，因为它不该为了被测到而拖进 3dmol 和 React。
 *
 * 这里认两种布局，因为实际拿到的文件两种都有：
 *
 * 标准（XMol）                      Tinker
 *   120                              120  [可选标题]
 *   comment                          1  C   -1.302  -0.499   0.472   2   2   6   8
 *   C  -1.302  -0.499   0.472        2  C   -0.771  -1.158  -0.566   2   1   3  79
 *   ...                              ...
 *
 * Tinker 那种**没有注释行**，而且原子行开头多一个序号列，后面还跟着原子类型和成键表。
 *
 * 3Dmol 2.5.5 只认标准那种，喂 Tinker 会连出两个错：
 *
 * 1. 它固定 `offset = 2`，把第一个原子当成注释跳掉，于是整体错位一行、末尾多读一行。
 *    文件以换行结尾时那一行是空串，`''.split(/\s+/)` 得到 `['']`，于是
 *    `elem[0].toUpperCase()` 抛 `Cannot read properties of undefined`。它前面那道
 *    `if (lines.length < atomCount + 2) break` 只数行数，拦不住。
 * 2. 就算不炸，它把 `tokens[0]` 当元素——那是序号，不是元素符号。而且 Tinker 行的
 *    第 5~7 列是原子类型和成键原子，3Dmol 在 `tokens.length >= 7` 时会把它们读成位移
 *    向量 dx/dy/dz。
 *
 * 所以 Tinker 行必须**重建**成标准四列交给 3Dmol，不能原样透传；标准行反过来要**保留
 * 原始文本**，因为那儿的第 5~7 列才是真的位移向量。两种布局的处理刚好相反，这是这个
 * 模块存在的理由。
 *
 * 成键表被丢掉了：3Dmol 自己按距离推断（assignBonds），对这些分子够用。
 */
export type XyzModel = {
  comment: string;
  atoms: { el: string }[];
  /** 交给 3Dmol 的那一份：标准布局、行都非空、原子数是实际数到的。 */
  model: string;
};

const num = (s: string) => Number.isFinite(Number(s));
/** Tinker 行：序号、名字、三个坐标。序号是整数，名字不是数——这两条把它和标准行分开。 */
const isTinkerRow = (p: string[]) =>
  p.length >= 5 && /^\d+$/.test(p[0]) && !num(p[1]) && num(p[2]) && num(p[3]) && num(p[4]);
/** 标准行：元素符号加三个坐标。 */
const isPlainRow = (p: string[]) => p.length >= 4 && !num(p[0]) && num(p[1]) && num(p[2]) && num(p[3]);

export function parseXyz(content: string): XyzModel | null {
  const lines = content.split(/\r?\n|\r/);
  if (lines.length < 2) return null;
  const head = lines[0].trim().split(/\s+/);
  const count = parseInt(head[0], 10);
  if (isNaN(count) || count <= 0) return null;

  // 布局由**第一行候选原子行**决定，而不是靠文件扩展名或猜。
  const firstBody = lines[1]?.trim().split(/\s+/) ?? [];
  const tinker = isTinkerRow(firstBody);
  // Tinker 没有注释行，首行原子数后面的剩余部分才是标题。
  const comment = tinker ? head.slice(1).join(" ") : (lines[1]?.trim() ?? "");

  const atoms: { el: string }[] = [];
  const kept: string[] = [];
  for (let i = tinker ? 1 : 2; i < lines.length && atoms.length < count; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const p = line.split(/\s+/);
    if (tinker) {
      if (!isTinkerRow(p)) break;
      atoms.push({ el: p[1] });
      // 重建：序号、类型、成键表都要丢掉，否则 3Dmol 会把它们当成元素和位移向量。
      kept.push(`${p[1]} ${p[2]} ${p[3]} ${p[4]}`);
    } else {
      if (!isPlainRow(p)) break;
      atoms.push({ el: p[0] });
      // 原样保留：第 5~7 列是真的位移向量，重建会丢掉。
      kept.push(line);
    }
  }
  if (atoms.length === 0) return null;
  return { comment, atoms, model: [String(atoms.length), comment, ...kept].join("\n") + "\n" };
}
