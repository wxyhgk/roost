/*
  右栏三态的守卫：`vendor/dsh/rightbar/presentation.ts`。

  和 `dsh-columns.test.ts` 是同一种东西——那个文件是整套三栏外壳里唯一能在 node 里测的
  部分，这个是整套右栏里唯一能测的部分。面板盒子（`RightbarPanel.tsx`）和它的 CSS Module
  在这儿一行都验不了：`frontend/tests` 没有 jsdom，`node --test` 也加载不了 `.module.css`。
  那半边只能画出来看。

  钉的是**三档之间那几条会被顺手改坏的边界**：
    · 768 以下一律全屏且不占轨（上游 SidebarRight.tsx 368/374 行的硬规矩）
    · 推挤放不下时降级成悬浮，而不是自己消失（我们相对上游的偏离，理由在源文件头）
    · 全屏**保留**它底下那条轨（退出全屏时对话宽度不跳）
    · 三档共用同一个宽度，而那个宽度必须和 AppFrame 那根把手画在同一条线上
*/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RIGHTBAR_AUTO_FULLSCREEN, resolveRightbarPresentation, rightbarPanelWidth,
} from '../src/vendor/dsh/rightbar/presentation.ts'
import { computeColumns, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MIN } from '../src/vendor/dsh/layout/columns.ts'

test('强制全屏的断点就是上游那个 768', () => {
  assert.equal(RIGHTBAR_AUTO_FULLSCREEN, 768)
})

test('收起时三个布尔值都不为真，但档次照算', () => {
  const closed = resolveRightbarPresentation({ expanded: false, mode: 'push', viewportWidth: 1400, canShow: true })
  assert.equal(closed.shown, false)
  assert.equal(closed.track, false)
  // 收起的面板没有卸载，只是被平移出边缘，它的 position 仍要按当前档次算。
  assert.equal(closed.fullscreen, false)
  assert.equal(closed.mode, 'push')

  const closedFull = resolveRightbarPresentation({ expanded: false, mode: 'fullscreen', viewportWidth: 1400, canShow: true })
  assert.equal(closedFull.shown, false)
  assert.equal(closedFull.track, false)
  assert.equal(closedFull.fullscreen, true, '全屏档收起时仍是全屏几何，否则展开那一瞬间会先闪一下推挤档')
})

test('推挤：占轨、不全屏', () => {
  const p = resolveRightbarPresentation({ expanded: true, mode: 'push', viewportWidth: 1400, canShow: true })
  assert.deepEqual(p, { shown: true, track: true, fullscreen: false, mode: 'push' })
})

test('悬浮：画出来了但不占轨——上游产生不出这个组合，框却支持', () => {
  const p = resolveRightbarPresentation({ expanded: true, mode: 'float', viewportWidth: 1400, canShow: true })
  assert.deepEqual(p, { shown: true, track: false, fullscreen: false, mode: 'float' })
})

test('全屏保留底下那条轨', () => {
  const p = resolveRightbarPresentation({ expanded: true, mode: 'fullscreen', viewportWidth: 1400, canShow: true })
  // track 为真是有意的：退出全屏时中栏不用重新让一次地方，对话宽度因此不跳。
  assert.deepEqual(p, { shown: true, track: true, fullscreen: true, mode: 'fullscreen' })
})

test('768 以下三档一律抬成全屏，而且不占轨', () => {
  for (const mode of ['push', 'float', 'fullscreen'] as const) {
    const p = resolveRightbarPresentation({ expanded: true, mode, viewportWidth: 767, canShow: true })
    assert.deepEqual(p, { shown: true, track: false, fullscreen: true, mode: 'fullscreen' }, mode)
  }
  // 断点本身属于宽的那一边（上游是 `< 768`）。
  const at = resolveRightbarPresentation({ expanded: true, mode: 'push', viewportWidth: 768, canShow: true })
  assert.equal(at.fullscreen, false)
  assert.equal(at.track, true)
})

test('推挤放不下时降级成悬浮，不是收起', () => {
  const p = resolveRightbarPresentation({ expanded: true, mode: 'push', viewportWidth: 900, canShow: false })
  assert.equal(p.shown, true, '面板仍然画出来——常驻图标条上刚点亮的那颗不该自己灭掉')
  assert.equal(p.track, false)
  assert.equal(p.fullscreen, false)
  assert.equal(p.mode, 'float')
})

test('悬浮和全屏不看 canShow：它们本来就不问中栏要地方', () => {
  const floating = resolveRightbarPresentation({ expanded: true, mode: 'float', viewportWidth: 900, canShow: false })
  assert.equal(floating.mode, 'float')
  const full = resolveRightbarPresentation({ expanded: true, mode: 'fullscreen', viewportWidth: 900, canShow: false })
  assert.equal(full.mode, 'fullscreen')
  assert.equal(full.track, true)
})

test('面板宽度优先取框解出来的那个数——把手画在同一条线上', () => {
  /*
    AppFrame 把右侧把手画在 `viewport - normal.rightbar`（AppFrame.tsx 222-224 行）。
    面板宽度要是另算一个数，把手就会浮在面板里面或外面几十个像素——这一条只有量过才看得见。
  */
  const viewport = 1400
  const normal = computeColumns(viewport, 280, viewport * 0.45).rightbar
  assert.equal(rightbarPanelWidth(normal, viewport * 0.45, viewport), normal)
})

test('框解出 0（放不下、把手本来就不画）时才退回偏好值', () => {
  // viewport 900、左栏 280：900 - 280 - 400 = 220 < 300，右栏整轨消失。
  const viewport = 900
  const normal = computeColumns(viewport, 280, 405).rightbar
  assert.equal(normal, 0, '前提：这个框宽下正常右栏确实放不下')
  const width = rightbarPanelWidth(normal, 405, viewport)
  assert.equal(width, 405, '悬浮档在这种框宽下仍然要画得出来')
})

test('面板不会比框还宽', () => {
  // 框比 RIGHTBAR_MIN 还窄时夹逼的下限会反超框宽。
  const width = rightbarPanelWidth(0, 1000, 240)
  assert.equal(width, 240)
  assert.ok(width <= 240)
})

test('推挤和悬浮共用同一个宽度：切档时动的只有中栏', () => {
  const viewport = 1600
  // resolveFrame 的那两行：normal 永远按「右栏正常展开」解，cols 才看占不占轨。
  const preference = viewport * RIGHTBAR_DEFAULT_RATIO
  const normal = computeColumns(viewport, 280, preference).rightbar
  const push = resolveRightbarPresentation({ expanded: true, mode: 'push', viewportWidth: viewport, canShow: normal > 0 })
  const float = resolveRightbarPresentation({ expanded: true, mode: 'float', viewportWidth: viewport, canShow: normal > 0 })
  const width = rightbarPanelWidth(normal, preference, viewport)
  assert.notEqual(push.track, float.track, '差别只在占不占轨')
  // 中栏：占轨时让出那块地，不占轨时保持满宽——而面板两档都是同一个 width。
  assert.equal(computeColumns(viewport, 280, push.track ? preference : 0).center, viewport - 280 - width)
  assert.equal(computeColumns(viewport, 280, float.track ? preference : 0).center, viewport - 280)
})

test('宽度永远夹在契约区间里', () => {
  for (let viewport = 400; viewport <= 2600; viewport += 37) {
    for (const preference of [0, 120, 300, 405, 900, 4000]) {
      const width = rightbarPanelWidth(0, preference, viewport)
      assert.ok(width <= viewport, `${viewport}/${preference}`)
      if (viewport >= RIGHTBAR_MIN) assert.ok(width >= RIGHTBAR_MIN, `${viewport}/${preference}`)
    }
  }
})
