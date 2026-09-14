/**
 * **一个分子结构，与任何查看器和编辑器无关。**
 *
 * 这是输入输出的边界：解析器产出它，查看器和序列化器消费它。2D 编辑器和 3D 查看器都会
 * 被换掉，而换掉时**不该动这个文件**——它描述的是分子本身，不是某个库的 API。
 *
 * 为什么值得单独立一层：在此之前 `plugins/xyz/parse.ts` 的输出里带着一个 `model` 字段，
 * 内容是「一段给 3Dmol 用的、规范化过的 XYZ 文本」。消费方的格式渗进了生产方，后果是
 * 具体的：Tinker 文件里写明的成键表**必须被丢掉**，因为标准 XYZ 的四列装不下它。换个
 * 查看器要重写解析器，而解析器本来和查看器无关。
 */

/** 下标从 0 开始，和 `atoms` 对齐。文件里的 1-based 序号由解析器负责换算。 */
export type Atom = {
  /** 元素符号，原样保留大小写由解析器规范化（`C`、`Cl`）。 */
  element: string;
  x: number;
  y: number;
  z: number;
  /**
   * 每原子的矢量：位移、简正振动模式、受力。XYZ 的第 5~7 列放的就是它。
   *
   * 建模成矢量而不是「原样保留那几列文本」，是因为它**是数据**——下一个查看器可以拿它
   * 画振动动画或力的箭头，而文本只能原样转发。
   */
  vector?: { x: number; y: number; z: number };
};

export type Bond = {
  a: number;
  b: number;
  /** 单/双/三键。文件没说时是 1。 */
  order: number;
};

export type Structure = {
  /** 注释行 / 标题块。没有就是空串。 */
  title: string;
  atoms: Atom[];
  /**
   * 文件里**写明**的键。
   *
   * 空数组要和 `bondsKnown: false` 一起读：前者是「这个文件没给键」，不是「这个分子没有键」。
   */
  bonds: Bond[];
  /**
   * 键是文件写明的，还是得让查看器按距离猜。
   *
   * 这个区别是有代价的：按距离猜对普通有机分子够用，但金属配位、拉长的键、非常规键长都会
   * 猜错。Tinker XYZ 自带成键表，猜它等于把已知信息扔掉再重新发明一遍。
   */
  bondsKnown: boolean;
};

/**
 * 序列化成标准（XMol）XYZ。
 *
 * 放在这儿而不是某个查看器里：XYZ 是一种**格式**，不是某个库的输入要求。需要把结构交给
 * 只吃 XYZ 文本的东西时用它——3Dmol 目前就是这样，但下一个查看器未必。
 *
 * 注意它**装不下键**：标准 XYZ 只有元素和坐标。所以拿它喂查看器时，`bondsKnown` 的信息
 * 就丢了——真要保住，查看器得能直接吃 Structure，或者走别的格式。
 */
export function toXyz(structure: Structure): string {
  // 带矢量的写七列（XYZ 的扩展写法），不带的写四列。坐标按解析出来的数值输出，
  // 所以文本不保证和原文逐字相同——`0.0` 会写成 `0`，数值等价。
  const rows = structure.atoms.map(a => {
    const head = `${a.element} ${a.x} ${a.y} ${a.z}`;
    return a.vector ? `${head} ${a.vector.x} ${a.vector.y} ${a.vector.z}` : head;
  });
  return [String(structure.atoms.length), structure.title, ...rows].join("\n") + "\n";
}
