/**
 * 路径在卡片这种窄地方的显示形式。
 *
 * 直接截断绝对路径是最差的做法：`/Users/you/Code/roost/packages…` 砍掉的恰好是
 * 唯一有辨识度的那一段。真正要回答的问题是「这是哪个目录」，而两个末段就够了——
 * 同名的 `backend` 靠上一级区分得开。
 */
export function shortPath(path: string, segments = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return parts.slice(-segments).join("/");
}
