/**
 * 截断方向是跟着数据语义走的，不是随便选的。
 *
 * 命令输出**留尾部**：报错、退出码、最后一行结论都在末尾，砍掉尾巴等于砍掉答案。
 * 文件内容和搜索结果反过来，那些留头部。所以这里只提供尾部截断，需要头部截断的地方
 * 自己写——两种截断混用一个函数只会让调用方搞错方向。
 */
export function tailText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  // 从 max 个字符处往后找第一个换行，从完整的一行开始，不要把一行劈成两半。
  const cut = text.length - max;
  const newline = text.indexOf("\n", cut);
  const start = newline >= 0 && newline - cut < 200 ? newline + 1 : cut;
  return { text: text.slice(start), clipped: true };
}
