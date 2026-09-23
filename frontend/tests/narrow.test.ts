import test from 'node:test';
import assert from 'node:assert/strict';
import { NARROW_LAYOUT_MAX, isNarrowLayout } from '../src/shared/narrow';

/*
  骨架是两条 40 像素图标栏 + 三个面板。窄屏下三段同时展开，中间就只剩百来像素。
  [实测] 390 像素的手机上不收起侧栏，面板标题会被截成 `W...`、`F...`，右面板的文件名全没。
*/
test('窄布局判定：手机和窄窗口算窄，常见桌面宽度不算', () => {
  // 真实设备宽度，都该判窄。
  for (const width of [320, 375, 390, 414, 430, 768, 820]) {
    assert.equal(isNarrowLayout(width), true, `${width} 应判为窄`);
  }
  // 再宽一点，左右面板各自还剩 300 以上，三段并排是能用的。
  for (const width of [821, 1024, 1280, 1920]) {
    assert.equal(isNarrowLayout(width), false, `${width} 不该判为窄`);
  }
});

test('阈值本身是闭区间的上界 —— 等于就算窄', () => {
  // 边界值只能这么验：截图验不了差一像素。
  assert.equal(isNarrowLayout(NARROW_LAYOUT_MAX), true);
  assert.equal(isNarrowLayout(NARROW_LAYOUT_MAX + 1), false);
});
