/**
 * 路径在卡片这种窄地方的显示形式。
 *
 * 直接截断绝对路径是最差的做法：`/Users/you/Code/roost/packages…` 砍掉的恰好是
 * 唯一有辨识度的那一段。真正要回答的问题是「这是哪个目录」，而两个末段就够了——
 * 同名的 `backend` 靠上一级区分得开。
 *
 * **住在 shared 而不是 terminal 里**：它是个纯粹的路径函数，和终端没有关系，只是最早
 * 只有画布卡片在用。侧栏的会话行要用它时，边界检查当场拦下了跨特性的直接引用
 * （terminal 有公共入口，必须走它）——而正确的答案不是从那个入口导出去，是让它住到
 * 它本来就该在的地方。`segments` 参数没有任何调用点传过，一并删掉。
 */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}
