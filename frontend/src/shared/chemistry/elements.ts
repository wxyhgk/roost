/**
 * CPK 配色：元素 → 颜色。
 *
 * 放在 chemistry 而不是某个查看器里，因为它是**画分子的通用约定**（Corey–Pauling–Koltun，
 * 后来 Jmol/PyMOL 各自微调），不是某个库的 API。图例上的小圆点和 3D 里的球必须是同一套
 * 颜色，而图例不该为了拿颜色去 import 查看器。
 *
 * 只列常见元素。查不到的由调用方自己兜底——补全整张周期表要等真有人用到。
 */
export const CPK: Record<string, string> = {
  H: "#ffffff", C: "#909090", N: "#3050f8", O: "#ff0d0d",
  F: "#90e050", Na: "#ab5cf2", Cl: "#1ff01f", S: "#ffff30",
  Li: "#cc80ff", B: "#ffb5b5", P: "#ff8000", Br: "#a62929",
  I: "#940094", K: "#8f6911", Ca: "#3dff00", Mg: "#8aff00",
  Al: "#bfa6a6", Si: "#f0c8a0",
};

/** 没收录的元素用中性灰，别让图例出现空洞。 */
export const UNKNOWN_ELEMENT_COLOR = "#8e8e93";
