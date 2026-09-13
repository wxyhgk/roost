import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, dayLabel, groupByDay, timeLabel } from "../src/features/conversations/when.ts";

const at = (iso: string) => new Date(iso).getTime();

test("同一天归为一组，跨天分开", () => {
  const a = at("2026-09-09T21:36:00"), b = at("2026-09-09T10:08:00"), c = at("2026-09-08T23:59:00");
  assert.equal(dayKey(a), dayKey(b), "同一天的两个时刻必须同组");
  assert.notEqual(dayKey(b), dayKey(c), "跨过午夜就是另一组");
});

test("今天/昨天用词，更早用日期", () => {
  const now = at("2026-09-09T12:00:00");
  assert.equal(dayLabel(at("2026-09-09T00:01:00"), now), "今天");
  assert.equal(dayLabel(at("2026-09-08T23:59:00"), now), "昨天");
  // 更早的用日期本身；具体格式跟随系统区域设置，这里只断言它不再是「今天/昨天」。
  const older = dayLabel(at("2026-09-01T10:00:00"), now);
  assert.ok(older !== "今天" && older !== "昨天" && older.length > 0);
});

test("组内只显示时刻，不重复日期", () => {
  const label = timeLabel(at("2026-09-09T21:36:16"));
  // 关键是不含年份——真实数据里全部 17 行的年月日完全相同，重复写就是噪音。
  assert.ok(!label.includes("2026"), `不该带年份: ${label}`);
  assert.ok(/\d/.test(label));
});

test("分组保持原有顺序，不重排", () => {
  const rows = [
    { id: "a", t: at("2026-09-09T21:36:00") },
    { id: "b", t: at("2026-09-09T10:08:00") },
    { id: "c", t: at("2026-09-08T22:00:00") },
    { id: "d", t: at("2026-09-08T09:00:00") },
  ];
  const groups = groupByDay(rows, r => r.t);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.items.map(r => r.id), ["a", "b"]);
  assert.deepEqual(groups[1]!.items.map(r => r.id), ["c", "d"]);
});

test("同一天的条目即使不相邻也不会被合并到一组", () => {
  // 列表按时间倒序，理论上不会出现这种顺序；真出现了也应如实分段，
  // 而不是把顺序悄悄改掉——那会让「按时间找」这件事失去依据。
  const rows = [
    { id: "a", t: at("2026-09-09T21:00:00") },
    { id: "b", t: at("2026-09-08T21:00:00") },
    { id: "c", t: at("2026-09-09T09:00:00") },
  ];
  const groups = groupByDay(rows, r => r.t);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(g => g.items.map(r => r.id)), [["a"], ["b"], ["c"]]);
});
