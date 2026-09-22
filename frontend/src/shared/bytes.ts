/**
 * 字节数的人话形式。**两种写法，一个刻度。**
 *
 * 原来有三份各写各的，而且互相不一致：
 * - `app/StatusBar.tsx` 的 `compact`：1024 进制，单位 `B/K/M/G/T`
 * - `features/server-monitor/format.ts` 的 `bytes`：1024 进制，单位 `B/KiB/MiB/GiB/TiB`
 * - `features/files/dropUpload.ts` 的 `formatBytes`：**1024 进制却标 `KB/MB/GB`**——这一份
 *   是错的，不只是不一致：1.5 MiB 标成 1.5 MB，少算约 5%
 *
 * 最扎眼的是前两份撞在**同一个按钮**上：状态栏那个内存按钮，可见文字走 `compact`（「12G」），
 * 它自己的 tooltip 走 `bytes`（「12.0 GiB」）。数值一致，写法不同，鼠标一悬停单位就变。
 *
 * 所以刻度只留一份，写法留两种：状态栏那一格宽度有限，`12G` 和 `12.0 GiB` 差的那几个字符
 * 是真的放不下——那是真实约束，不是随意。`K` 在这里就是 `KiB` 的缩写，两者永远同刻度。
 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

function scale(value: number): { n: number; power: number } {
  let n = value, power = 0;
  while (n >= 1024 && power < UNITS.length - 1) { n /= 1024; power++; }
  return { n, power };
}

/** 完整写法：tooltip、监控面板、上传确认框这些有地方的场合。 */
export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const { n, power } = scale(value);
  return `${n.toFixed(power ? n >= 100 ? 0 : 1 : 0)} ${UNITS[power]}`;
}

/** 状态栏那一格：没有空格、单位只留首字母。同刻度，`G` 就是 `GiB`。 */
export function compactBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const { n, power } = scale(value);
  return `${n.toFixed(power && n < 10 ? 1 : 0)}${UNITS[power][0]}`;
}
