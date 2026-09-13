/**
 * 英文可数名词的单复数。
 *
 * 中文不区分单复数（「1 个会话」「3 个会话」都成立），所以从中文逐字对译时
 * 最容易漏掉这一层；而类型检查和漏翻检测都发现不了——只有 n === 1 时才看得出来。
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
