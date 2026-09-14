/**
 * XYZ 的解析和**归一化**。单独一个模块，因为它不该为了被测到而拖进 3dmol 和 React。
 *
 * `model` 这个字段是这里存在的理由。3Dmol 2.5.5 的 XYZ 解析器（build/3Dmol.js 的
 * `function XYZ`）长这样：
 *
 *     if (lines.length < atomCount + 2) break;   // 只数行数，不看内容
 *     ...
 *     var tokens = line.trim().split(/\s+/);
 *     var elem = tokens[0];
 *     atom.atom = atom.elem = elem[0].toUpperCase() + ...
 *
 * 原子块里只要混进一个空行，`''.split(/\s+/)` 得到 `['']`，`elem[0]` 就是 undefined，
 * 于是抛 `Cannot read properties of undefined (reading 'toUpperCase')`。头部声明的原子数
 * 比实际多、后面拿空行凑数的文件同样中招——它只检查总行数够不够。
 *
 * 而我们自己这个解析器一向是防御性的（坏行就停），于是同一份文件表头渲染得好好的、
 * 视图却炸了，两边对「这是什么」的判断不一致。所以改成：**由这里产出一份保证干净的
 * XYZ 交给 3Dmol**，而不是把原文丢过去。
 *
 * 归一化保留**原始行文本**而不是用解析出的字段重建：XYZ 第 5~7 列可以带位移向量
 * （3Dmol 在 `tokens.length >= 7` 时会读 dx/dy/dz），重建会把它们丢掉。
 *
 * 空行是跳过而不是就此打住：「这个文件里有 N 个原子」是作者的意图，中间多一个空行是
 * 手写或者工具输出的瑕疵，不该让后面的原子一起消失。
 */
export type XyzModel = {
  comment: string;
  atoms: { el: string }[];
  /** 交给 3Dmol 的那一份：原子数是实际数得到的，行都非空。 */
  model: string;
};

export function parseXyz(content: string): XyzModel | null {
  const lines = content.split(/\r?\n|\r/);
  if (lines.length < 3) return null;
  const count = parseInt(lines[0].trim(), 10);
  if (isNaN(count) || count <= 0) return null;
  const comment = lines[1]?.trim() ?? "";
  const atoms: { el: string }[] = [];
  const kept: string[] = [];
  for (let i = 2; i < lines.length && atoms.length < count; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const parts = line.split(/\s+/);
    // 前四列是元素和坐标；元素为空或坐标不是数，这一行就不是原子行。
    if (parts.length < 4 || !parts[0] || parts.slice(1, 4).some(n => !Number.isFinite(Number(n)))) break;
    atoms.push({ el: parts[0] });
    kept.push(line);
  }
  if (atoms.length === 0) return null;
  return { comment, atoms, model: [String(atoms.length), comment, ...kept].join("\n") + "\n" };
}
