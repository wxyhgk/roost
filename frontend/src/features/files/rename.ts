/*
  重命名的目标路径，以及「这个名字不算改名」的判定。

  抽成纯函数的理由和 `features/windows/geometry.ts` 一样：这几行里全是**不报错的错法**，
  而它们藏在一个 async 的事件处理器里，只能靠手点去试。

  - 前缀切错 → 新路径落到别的目录里，等于静悄悄地**移动**了文件
  - 名字里带 `/` 不拦 → 后端按路径解析，同样是移动，而且可能穿出当前目录
  - 空名字不拦 → 新路径以 `/` 结尾或退化成目录本身
  - 没改名也发一次请求 → 后端把「改成同名」当冲突报错，用户按了回车却看到一句「重命名失败」
*/

/**
 * 把 `path` 改名成 `name` 之后的路径；**不构成一次改名时返回 null**（调用方什么都不做）。
 *
 * `path` 是相对当前根的相对路径，返回的也是——只换最后一段，前面那串原样带着。
 * 顶层条目没有 `/`，此时整条路径就是那一段。
 */
export function renameTarget(path: string, name: string): string | null {
  const clean = name.trim();
  // `/` 一律拒绝：它不是非法字符，而是**另一种操作**（移动），不该从改名输入框里悄悄发生。
  if (!clean || clean.includes("/")) return null;
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  // 和原名相同就不算改名。比的是**路径的末段**而不是传进来的 name：两者在正常情况下
  // 相等，而不等的时候（比如上一次改名的结果还没传下来）该听路径的。
  if (clean === path.slice(slash + 1)) return null;
  return `${dir}${clean}`;
}
