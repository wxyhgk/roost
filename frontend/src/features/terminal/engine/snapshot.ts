/** Scrollback rows to attempt per snapshot, largest first; 0 keeps the viewport only. */
const SNAPSHOT_SCROLLBACK_STEPS = [2000, 500, 0];

/**
 * 挑一份装得进 `maxLength` 的快照。
 *
 * 超限的快照是**整份丢掉**的，所以不能先把两万行 scrollback 序列化出来再看长度——那一次
 * 白跑的序列化正是要省的东西。改成逐级退：2000 行 → 500 行 → 只剩当前屏。连只剩当前屏都
 * 超限时返回 `null`——宁可没有快照，也不能给一份会被整份丢掉的。
 *
 * `serialize` 注入进来（而不是直接吃 SerializeAddon）纯粹是为了能测：假一个按行数返回不同
 * 长度的 serialize，就能验「超限时退到哪一级」，而不必开一个真终端往里灌两万行。
 */
export function pickSnapshot(
  serialize: (scrollback: number) => string,
  suffix: string,
  wantsSgrMouse: boolean,
  maxLength: number,
): string | null {
  for (const scrollback of SNAPSHOT_SCROLLBACK_STEPS) {
    let data = serialize(scrollback) || '';
    // 恢复出来的屏要连鼠标模式一起恢复，否则 TUI 还在跑而滚轮忽然不灵了。
    // 序列化自己带上了就不重复补。
    if (wantsSgrMouse && !data.includes('\x1b[?1006h')) data += '\x1b[?1006h';
    const full = data + suffix;
    if (full.length <= maxLength) return full || null;
  }
  return null;
}
