import type { ProcessInfo } from '@roost/server-monitor/types';
/*
  进程表的筛选 + 排序。

  筛选把 name / pid / user 拼成一行再匹配，而不是分字段匹配：人在那个框里敲的东西
  自己不带字段名——可能是 `node`、可能是 `1234`、也可能是自己的用户名，拼成一行一次盖住。

  **并列不额外破。** `Array.prototype.sort` 在 ES2019 之后保证稳定，所以 cpu 同为 0
  的那一大片（平时占进程表的多数）保持服务端给的顺序；服务端那份顺序本身是稳定的，
  于是列表不会在每 5 秒一次的刷新里自己乱跳。加一条 pid 兜底反而会把它打乱成另一种顺序。

  `sort` 收 string 而不是联合类型：调用处的那两个按钮是照数组渲染的，id 就是 string。
  除 'memory' 以外一律按 cpu——这是原来 `sort === 'memory' ? … : …` 的行为，照搬。
*/
export function rankProcesses(list: ProcessInfo[], filter: string, sort: string): ProcessInfo[] {
  const needle = filter.toLowerCase();
  return list
    .filter(row => `${row.name} ${row.pid} ${row.user}`.toLowerCase().includes(needle))
    .sort((a, b) => sort === 'memory' ? b.memory - a.memory : (b.cpu ?? 0) - (a.cpu ?? 0));
}
