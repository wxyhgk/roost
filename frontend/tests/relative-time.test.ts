import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../src/vendor/dsh/relative-time.ts';

/*
  会话行尾那个相对时间（`3min` / `2h` / `5d`）的分档函数。

  **为什么单独钉一份测试**：这个函数是逐字从 deepseek-harness 搬来的，而它的档位边界
  （1 分钟、1 小时、1 天、30 天、365 天）是**写死的常数**，不是从 Intl 派生的。重新同步
  上游时如果哪个常数变了，界面上的变化是「本来写 59min 的行忽然写 1h」——没人会注意到，
  而 typecheck 和别的测试一个都拦不住。

  钉的是**边界前后各一格**，不是中间值：中间值任何一个实现都对，边界才是会变的地方。

  分档函数是纯 .ts，所以进得了 `node --test`（`frontend/tests/` 没有 jsdom，
  加载 CSS Module 的组件在这里跑不起来）。**档位的文字**不在这里——上游把它留在各自的
  词典里，我们也一样，接线时由调用方给。
*/

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 固定的「现在」，免得测试自己变成时钟的函数。 */
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

/** `now - diff` 时刻落在哪个档。 */
const ago = (diff: number) => relativeTime(NOW - diff, NOW);

test('刚刚：不足一分钟的一律是 now，且量级是 0', () => {
  assert.deepEqual(ago(0), { unit: 'now', n: 0 });
  assert.deepEqual(ago(1), { unit: 'now', n: 0 });
  assert.deepEqual(ago(MIN - 1), { unit: 'now', n: 0 });
});

test('未来的时刻也算 now，不会出现负数', () => {
  // 时钟回拨、或者服务端时间比浏览器快一点，都会让 at > now。
  // 上游用 Math.max(0, …) 兜住；没有它的话 Math.floor(-1/60000) 是 -1，
  // 界面上会出现「-1min」。
  assert.deepEqual(relativeTime(NOW + DAY, NOW), { unit: 'now', n: 0 });
});

test('分钟档：[1min, 1h)', () => {
  assert.deepEqual(ago(MIN), { unit: 'minutes', n: 1 });
  assert.deepEqual(ago(3 * MIN), { unit: 'minutes', n: 3 });
  assert.deepEqual(ago(HOUR - 1), { unit: 'minutes', n: 59 });
});

test('小时档：[1h, 1d)', () => {
  assert.deepEqual(ago(HOUR), { unit: 'hours', n: 1 });
  assert.deepEqual(ago(2 * HOUR), { unit: 'hours', n: 2 });
  assert.deepEqual(ago(DAY - 1), { unit: 'hours', n: 23 });
});

test('天档：[1d, 30d)', () => {
  assert.deepEqual(ago(DAY), { unit: 'days', n: 1 });
  assert.deepEqual(ago(5 * DAY), { unit: 'days', n: 5 });
  assert.deepEqual(ago(30 * DAY - 1), { unit: 'days', n: 29 });
});

test('月档：[30d, 365d)，一个月按 30 天算', () => {
  assert.deepEqual(ago(30 * DAY), { unit: 'months', n: 1 });
  assert.deepEqual(ago(90 * DAY), { unit: 'months', n: 3 });
  // **这一条看着像 bug，其实是上游的定义**：月按 30 天、年按 365 天，两个除数不一致，
  // 所以年档的前一格是「12mo」而不是「11mo」。照抄的是上游的行为，不是我们选的。
  assert.deepEqual(ago(365 * DAY - 1), { unit: 'months', n: 12 });
});

test('年档：满 365 天才进', () => {
  assert.deepEqual(ago(365 * DAY), { unit: 'years', n: 1 });
  assert.deepEqual(ago(800 * DAY), { unit: 'years', n: 2 });
});

test('跨年不等于「一年前」：差一天就是一天', () => {
  // 分档只看毫秒差，不看日历年。除夕到初一是 1 天，不能因为年份变了就跳到年档——
  // 一个按日历年算的实现在这里会写「1y」。
  const newYearsEve = Date.UTC(2025, 11, 31, 23, 30, 0);
  const newYearsDay = Date.UTC(2026, 0, 1, 23, 30, 0);
  assert.deepEqual(relativeTime(newYearsEve, newYearsDay), { unit: 'days', n: 1 });
  // 同理，跨年那 20 秒仍然是 now。
  assert.deepEqual(
    relativeTime(Date.UTC(2025, 11, 31, 23, 59, 45), Date.UTC(2026, 0, 1, 0, 0, 5)),
    { unit: 'now', n: 0 },
  );
});
