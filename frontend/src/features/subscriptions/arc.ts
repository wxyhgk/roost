/*
  额度环的弧。

  环画在 20×20 的 viewBox 里：圆心 (10,10)、半径 8.5、描边 2.5，所以外沿正好贴着 20×20 的
  边。弧从十二点开始顺时针走，走过的角度就是**剩余**比例——和它旁边那个数字是同一个量。

  两处看着像魔法数、其实都是防具体故障的：

  **`99.99` 的钳位。** SVG 的 `A` 是「从当前点画一段弧到目标点」，当剩余正好是 100 时目标点
  和起点重合，浏览器认为这段弧无处可去，**什么都不画**——一个满格的环会凭空消失，而那正是
  最不该出事的读数。留 0.01% 的缺口，肉眼看不出来，弧就一直存在。

  **大弧标志。** 超过半圈时 `A` 必须显式说「走大的那一边」，否则它会抄近路画成小弧——
  87% 会画得和 13% 一模一样，而且不报错。这是这段里唯一一个错了也不会崩、只会静悄悄说谎的
  地方，所以它有自己的用例。
*/
export const RING = { size: 20, center: 10, radius: 8.5, stroke: 2.5 } as const;

/**
 * 剩余比例对应的弧。
 *
 * @param remaining 0–100。`<= 0` 返回 `null`——空弧不该画成一个点，让调用方整段省掉。
 */
export function arcPath(remaining: number): string | null {
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const { center: c, radius: r } = RING;
  const angle = (Math.min(remaining, 99.99) / 100) * Math.PI * 2;
  const x = c + r * Math.sin(angle), y = c - r * Math.cos(angle);
  return `M${c},${c - r}A${r},${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(2)},${y.toFixed(2)}`;
}
