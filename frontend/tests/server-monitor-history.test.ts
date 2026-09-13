import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendSeries, segments, type Series } from '../src/features/server-monitor/history.ts';
test('history deduplicates cached samples, bounds retained data and resets for a different interface', () => {
  let s: Series = { source: '', points: [] };
  for (let i = 0; i < 100; i++) s = appendSeries(s, 'eth0', i * 5000, i);
  assert.equal(s.points.length, 60);
  assert.equal(appendSeries(s, 'eth0', 495000, 12), s);
  assert.deepEqual(appendSeries(s, 'eth1', 500000, 2).points, [{ at: 500000, value: 2 }]);
  assert.deepEqual(appendSeries(s, 'eth0', 900000, null).points, [{ at: 900000, value: null }]);
});
test('trends preserve real time spacing and never connect across missing samples or a hidden interval', () => {
  const points = [1000, 6000, 11000, 16000, 40000, 45000].map((at, i) => ({ at, value: i === 2 ? null : 10 }));
  const paths = segments(points, 100);
  assert.equal(paths.length, 2);
  assert.ok(paths[0].startsWith('0,25.4 '));
  assert.ok(paths[1].endsWith('100,25.4'));
  assert.deepEqual(segments([{ at: 1, value: null }]), []);
});
