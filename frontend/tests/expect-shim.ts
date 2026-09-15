import assert from 'node:assert/strict';
import { it as nodeIt } from 'node:test';

/**
 * vitest 的最小垫片，只为**逐字保留**从第三方抄来的测试文件而存在。
 *
 * 我们用 `node:test`，差的是 vitest 的 `expect` 和 `it.each`。抄来的 505 行测试里只用了
 * 三个匹配器加一个参数化——与其逐个改写成 assert（改写就等于让这份文件从此和上游分叉、
 * 再也同步不回来），不如补上这几样。
 *
 * **不要往这里加东西来伺候我们自己写的测试。** 我们自己的测试用 node:assert，
 * 这个文件只服务于「抄来的、要保持可同步的」那几份。
 */
export function expect(actual: unknown) {
  return {
    toEqual(expected: unknown) { assert.deepEqual(actual, expected); },
    toBe(expected: unknown) { assert.strictEqual(actual, expected); },
    toHaveLength(length: number) {
      assert.equal((actual as { length?: number })?.length, length);
    },
  };
}

/**
 * `it` 加上 `.each`：参数化用例，每行是一个参数元组，**展开**成回调的入参。
 * 名字里的 `%s` 占位符按 vitest 的语义逐个替换成该行的值。
 */
type EachRow = readonly unknown[];
export const it = Object.assign(nodeIt, {
  each<T extends EachRow>(table: readonly T[]) {
    return (name: string, fn: (...args: T) => void | Promise<void>) => {
      for (const row of table) {
        let i = 0;
        const title = name.replace(/%[sdif]/g, () => String(row[i++]));
        nodeIt(title, () => fn(...row));
      }
    };
  },
});
