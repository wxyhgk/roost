import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessInfo } from '@roost/server-monitor/types';
import { rankProcesses } from '../src/features/server-monitor/processes.ts';

const proc = (name: string, pid: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid, name, user: 'alice', cpu: 0, memory: 0, state: 'sleeping',
  parentPid: null, threads: null, priority: null, virtualMemory: null, ...extra,
});
const names = (rows: ProcessInfo[]) => rows.map(row => row.name);

test('the filter matches name, pid or user in one pass, case-insensitively', () => {
  const list = [proc('node', 12345), proc('Postgres', 900, { user: 'pg' }), proc('WindowServer', 234, { user: '_windowserver' })];
  assert.deepEqual(names(rankProcesses(list, '', 'cpu')), ['node', 'Postgres', 'WindowServer']);
  /* 两边都要降写：名字是 `Postgres`，而这一行的 user 里没有第二份小写的同名给它兜着。 */
  assert.deepEqual(names(rankProcesses(list, 'POSTGRES', 'cpu')), ['Postgres']);
  assert.deepEqual(names(rankProcesses(list, 'postgres', 'cpu')), ['Postgres']);
  // 数字当子串匹配，而不是等于 pid：人记得住的往往只是开头那几位。
  assert.deepEqual(names(rankProcesses(list, '234', 'cpu')), ['node', 'WindowServer']);
  assert.deepEqual(names(rankProcesses(list, '_windowserver', 'cpu')), ['WindowServer']);
  assert.deepEqual(rankProcesses(list, 'nothing-here', 'cpu'), []);
  /* 三格是拼成 `name pid user` 一行再匹配的，所以跨字段的连写搜不到，但空格能跨过去。 */
  assert.deepEqual(names(rankProcesses(list, 'node 12345', 'cpu')), ['node']);
  assert.deepEqual(rankProcesses(list, 'node12345', 'cpu'), []);
});

test('sorting is by cpu unless memory is asked for, with missing cpu counted as zero', () => {
  const list = [proc('low', 1, { cpu: 1, memory: 900 }), proc('unknown', 2, { cpu: null, memory: 500 }), proc('high', 3, { cpu: 50, memory: 100 })];
  assert.deepEqual(names(rankProcesses(list, '', 'cpu')), ['high', 'low', 'unknown']);
  assert.deepEqual(names(rankProcesses(list, '', 'memory')), ['low', 'unknown', 'high']);
  /* 只有 'memory' 有意义，其余一律按 cpu——按钮的 id 是 string，来一个不认识的不该翻脸。 */
  assert.deepEqual(names(rankProcesses(list, '', 'nonsense')), ['high', 'low', 'unknown']);
});

test('ties keep the order the server gave, and the input list is left alone', () => {
  /*
    **并列不额外破。** 平时进程表里 cpu 为 0 的占多数，如果给它们再排一道（比如按 pid），
    那一片就会按另一种顺序重排，而它每 5 秒刷新一次——人看到的是列表自己在跳。
  */
  const list = [proc('c', 3), proc('a', 1), proc('b', 2)];
  assert.deepEqual(names(rankProcesses(list, '', 'cpu')), ['c', 'a', 'b']);
  assert.deepEqual(names(rankProcesses(list, '', 'memory')), ['c', 'a', 'b']);
  // 排序不能就地改调用方那份：p.list 是快照的一部分，别人还要读它。
  assert.deepEqual(names(list), ['c', 'a', 'b']);
  const sorted = [proc('big', 1, { cpu: 9 }), proc('mid', 2, { cpu: 5 }), proc('also-mid', 3, { cpu: 5 })];
  assert.deepEqual(names(rankProcesses(sorted, '', 'cpu')), ['big', 'mid', 'also-mid']);
});
