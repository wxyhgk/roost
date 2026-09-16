// 重放数据横跨几何变化时，客户端要在守护进程标出的下标处改网格，而不是整段按最终宽度解析。
// 另一半（守护进程怎么算这些下标）在 packages/terminal-runtime/tests/replay-geometry.test.ts。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResume, type ResumeFrame } from '../src/features/terminal/session/resume';

/** 把写入和改尺寸记在同一条轨迹上——顺序就是这一笔要钉的东西。 */
function recorder(cols = 80, rows = 24) {
  const trace: string[] = [];
  let size = { cols, rows };
  return {
    trace,
    sink: {
      get cols() { return size.cols; },
      get rows() { return size.rows; },
      resize(next: number, nextRows: number) { size = { cols: next, rows: nextRows }; trace.push(`resize:${next}x${nextRows}`); },
      reset() { trace.push('reset'); },
      snapshot: () => null,
      write(data: string, done: () => void) { trace.push(`write:${data}`); done(); },
    },
  };
}

/**
 * 建立基线再跑增量。
 *
 * catchup 只有在有基线之后才被接受（没基线的增量无从对齐），所以测增量一定要先走这一步。
 */
async function withBaseline(run: (resume: ReturnType<typeof createResume>, harness: ReturnType<typeof recorder>) => Promise<void>) {
  const harness = recorder();
  const resume = createResume(harness.sink);
  try {
    await resume.prepare('pty', null, false, { cols: 80, rows: 24 });
    await resume.accept({ type: 'replay', instanceId: 'pty', seq: 1, data: 'BASE' }).done;
    harness.trace.length = 0;
    await run(resume, harness);
  } finally { resume.dispose(); }
}

test('几何切换点把重放数据切成段，改网格发生在段与段之间', async () => {
  await withBaseline(async (resume, { trace, sink }) => {
    await resume.accept({
      type: 'catchup', instanceId: 'pty', seq: 3, data: 'AAABBB',
      resizes: [{ at: 3, cols: 100, rows: 30 }],
    } as ResumeFrame).done;
    assert.deepEqual(trace, ['write:AAA', 'resize:100x30', 'write:BBB']);
    assert.equal(sink.cols, 100);
  });
});

test('没有切换点就是一整块——老守护进程走的正是这条', async () => {
  await withBaseline(async (resume, { trace }) => {
    await resume.accept({ type: 'catchup', instanceId: 'pty', seq: 3, data: 'AAABBB' }).done;
    assert.deepEqual(trace, ['write:AAABBB']);
  });
});

test('切换点落在数据开头时先改网格再写', async () => {
  await withBaseline(async (resume, { trace }) => {
    await resume.accept({
      type: 'catchup', instanceId: 'pty', seq: 3, data: 'BBB',
      resizes: [{ at: 0, cols: 100, rows: 30 }],
    } as ResumeFrame).done;
    assert.deepEqual(trace, ['resize:100x30', 'write:BBB']);
  });
});

test('全量重放也照样分段：先摆好起始几何，再按切换点往前走', async () => {
  const { trace, sink } = recorder();
  const resume = createResume(sink);
  try {
    await resume.prepare('pty', null, false, { cols: 80, rows: 24 });
    await resume.accept({
      type: 'replay', instanceId: 'pty', seq: 2, data: 'SNAPTAIL', cols: 80, rows: 24,
      resizes: [{ at: 4, cols: 120, rows: 40 }],
    } as ResumeFrame).done;
    assert.deepEqual(trace, ['reset', 'resize:80x24', 'write:SNAP', 'resize:120x40', 'write:TAIL']);
    assert.equal(sink.cols, 120);
  } finally { resume.dispose(); }
});

test('下标越界或乱序不吞数据——最坏是少切一刀', async () => {
  await withBaseline(async (resume, { trace, sink }) => {
    await resume.accept({
      type: 'catchup', instanceId: 'pty', seq: 3, data: 'AAABBB',
      // 倒序、负数、超出末尾：帧是外部输入，坏了也不该让重放卡住或漏字节。
      resizes: [{ at: 4, cols: 90, rows: 20 }, { at: -5, cols: 100, rows: 30 }, { at: 999, cols: 110, rows: 40 }],
    } as ResumeFrame).done;
    assert.equal(trace.filter((row) => row.startsWith('write:')).map((row) => row.slice(6)).join(''), 'AAABBB');
    assert.equal(sink.cols, 110);
  });
});
