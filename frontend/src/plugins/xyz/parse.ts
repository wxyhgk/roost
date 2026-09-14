import type { Atom, Bond, Structure } from "../../shared/chemistry/structure";

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
/*
  **产出的是中立的 Structure，不是「给某个查看器用的文本」。**

  上一版这里返回的是 `{ comment, atoms, model }`，其中 model 是一段规范化过的 XYZ 文本
  ——专门喂 3Dmol 的。消费方的格式渗进了生产方，代价很具体：标准 XYZ 只有四列，装不下
  Tinker 写明的成键表，所以那张表**必须在这里被丢掉**，再让 3Dmol 按距离重新猜一遍。

  现在它产出结构本身，键留着；要 XYZ 文本的人自己调 toXyz()。
*/

const num = (s: string) => Number.isFinite(Number(s));
/** Tinker 行：序号、名字、三个坐标。序号是整数，名字不是数——这两条把它和标准行分开。 */
const isTinkerRow = (p: string[]) =>
  p.length >= 5 && /^\d+$/.test(p[0]) && !num(p[1]) && num(p[2]) && num(p[3]) && num(p[4]);
/** 标准行：元素符号加三个坐标。 */
const isPlainRow = (p: string[]) => p.length >= 4 && !num(p[0]) && num(p[1]) && num(p[2]) && num(p[3]);

export function parseXyz(content: string): Structure | null {
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

  const atoms: Atom[] = [];
  /** Tinker 的成键表是 1-based 且两端各写一次，先收原始编号，末尾再去重换算。 */
  const linked: [number, number][] = [];
  for (let i = tinker ? 1 : 2; i < lines.length && atoms.length < count; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const p = line.split(/\s+/);
    if (tinker) {
      if (!isTinkerRow(p)) break;
      atoms.push({ element: p[1], x: Number(p[2]), y: Number(p[3]), z: Number(p[4]) });
      // 第 6 列是原子类型，第 7 列起是成键原子的序号。
      for (const raw of p.slice(6)) if (/^\d+$/.test(raw)) linked.push([Number(p[0]), Number(raw)]);
    } else {
      if (!isPlainRow(p)) break;
      // 第 5~7 列是每原子矢量（位移/振动模式/受力），XYZ 的扩展写法。有就收下。
      const vector = p.length >= 7 && num(p[4]) && num(p[5]) && num(p[6])
        ? { x: Number(p[4]), y: Number(p[5]), z: Number(p[6]) } : undefined;
      atoms.push({ element: p[0], x: Number(p[1]), y: Number(p[2]), z: Number(p[3]), ...(vector ? { vector } : {}) });
    }
  }
  if (atoms.length === 0) return null;

  /*
    去重换算：Tinker 在两端各写一次（1 说自己连 2，2 也说自己连 1），而且序号是 1-based。
    只留 a < b 的那一条；指向没读进来的原子（文件声明的原子数比实际多时会出现）一律丢弃。
  */
  const seen = new Set<string>(), bonds: Bond[] = [];
  for (const [from, to] of linked) {
    const a = Math.min(from, to) - 1, b = Math.max(from, to) - 1;
    if (a < 0 || b >= atoms.length || a === b) continue;
    const key = `${a}-${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bonds.push({ a, b, order: 1 });
  }
  return { title: comment, atoms, bonds, bondsKnown: tinker };
}
