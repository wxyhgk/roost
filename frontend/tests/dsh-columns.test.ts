/*
  栏宽契约的守卫：`vendor/dsh/layout/columns.ts`。

  这个文件是整套三栏外壳里**唯一能在 node 里测的部分**——它零 import、纯函数。框本身
  （AppFrame.tsx）和它的 CSS Module 在这儿一行都验不了：`frontend/tests` 没有 jsdom，
  `node --test` 也加载不了 `.module.css`。那半边靠 `tests/browser/dsh-app-frame.html` 画出来看。

  钉的是**让步顺序**，因为那是这套几何里唯一会被后人「顺手改一下」改坏的东西，而改坏之后
  界面上看起来只是「某个宽度下右栏怪怪的」，不会报错：

      右栏先缩到 300 → 再整条轨道消失 → 中栏这时才允许掉到 400 以下 → 左栏永不让步

  上游那六行代码把这个顺序写得很紧凑（一个 min、一个三元），读代码看不出它有顺序语义，
  所以用例按这四档各钉一遍，外加一条覆盖全宽度区间的性质断言。
*/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CENTER_MIN, clampWidth, computeColumns, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '../src/vendor/dsh/layout/columns.ts'

test('契约常数就是上游那九个数', () => {
  // 这些数字散落在 AppFrame.module.css 的注释、侧栏轨的 56px 里对得上，改动必须是有意的。
  assert.equal(CENTER_MIN, 400)
  assert.equal(SIDEBAR_MIN, 264)
  assert.equal(SIDEBAR_MAX, 420)
  assert.equal(SIDEBAR_DEFAULT, 280)
  assert.equal(SIDEBAR_COLLAPSED, 56)
  assert.equal(SIDEBAR_AUTO_COLLAPSE, 1024)
  assert.equal(RIGHTBAR_MIN, 300)
  assert.equal(RIGHTBAR_MAX_RATIO, 0.7)
  assert.equal(RIGHTBAR_DEFAULT_RATIO, 0.45)
})

test('clampWidth 先四舍五入再夹逼，但上界本身不取整', () => {
  assert.equal(clampWidth(280, SIDEBAR_MIN, SIDEBAR_MAX), 280)
  assert.equal(clampWidth(100, SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MIN)
  assert.equal(clampWidth(9999, SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MAX)
  // 指针给的是小数（devicePixelRatio、缩放），所以 Math.round 在最里层。
  assert.equal(clampWidth(279.6, SIDEBAR_MIN, SIDEBAR_MAX), 280)
  assert.equal(clampWidth(263.4, SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MIN)
  assert.equal(clampWidth(420.5, SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MAX)
  /*
    **上界不过 Math.round**：`Math.min(max, Math.max(min, Math.round(px)))` 里 round 只
    包着 px。computeColumns 传进来的上界是 `viewport * 0.7`，于是夹到上界时结果是小数，
    而那个小数会原样进 gridTemplateColumns。不是 bug，但别人重构成「统一取整」就改了行为。
  */
  assert.equal(clampWidth(9999, RIGHTBAR_MIN, 700.7), 700.7)
})

test('宽屏：三栏各拿各的，加起来正好是框宽', () => {
  const cols = computeColumns(1600, 280, 720)
  assert.deepEqual(cols, { sidebar: 280, center: 600, rightbar: 720 })
  assert.equal(cols.sidebar + cols.center + cols.rightbar, 1600)
})

test('左栏偏好 0 = 那条 56px 的图标轨，不是 0 宽', () => {
  assert.deepEqual(computeColumns(1600, 0, 720), { sidebar: SIDEBAR_COLLAPSED, center: 824, rightbar: 720 })
})

test('左栏的偏好照样过夹逼', () => {
  assert.equal(computeColumns(1600, 100, 0).sidebar, SIDEBAR_MIN)
  assert.equal(computeColumns(1600, 9999, 0).sidebar, SIDEBAR_MAX)
})

test('右栏偏好 0 = 不要轨道，整条地都归中栏', () => {
  assert.deepEqual(computeColumns(1600, 280, 0), { sidebar: 280, center: 1320, rightbar: 0 })
})

test('右栏封顶在框宽的 70%', () => {
  /*
    要让 70% 这条真的咬住，得让「中栏让完之后剩下的地」比 70% 还多，也就是
    viewport - 56 - 400 > 0.7 * viewport，即 viewport > 1520。1200 那种宽度下
    先咬住的是可用宽度，看不出这条封顶。
  */
  const cols = computeColumns(2001, 0, 9999)
  assert.equal(cols.rightbar, 2001 * RIGHTBAR_MAX_RATIO)
  assert.equal(cols.center, 2001 - SIDEBAR_COLLAPSED - cols.rightbar)
  // 顺带钉住上一条：封顶咬住时宽度是小数，直接进 CSS。
  assert.ok(!Number.isInteger(cols.rightbar))
})

test('让步第一步：右栏被压，中栏钉在 400 不动', () => {
  // 1100 的框里，右栏要 700 只能拿到 420——正好是「中栏保住 400 之后剩下的地」。
  const cols = computeColumns(1100, 280, 700)
  assert.deepEqual(cols, { sidebar: 280, center: CENTER_MIN, rightbar: 420 })
})

test('让步第二步：压到 300 也塞不下时，整条轨道消失，中栏把地全收回去', () => {
  // 980 是最后一个还留着轨道的框宽：可用宽度正好等于 RIGHTBAR_MIN。
  assert.deepEqual(computeColumns(980, 280, 700), { sidebar: 280, center: CENTER_MIN, rightbar: RIGHTBAR_MIN })
  /*
    再窄 1px，可用宽度 299 < 300：**不是把右栏缩到 299**，而是整条轨道归零。
    中栏因此从 400 一跳跳到 699——让步是「有或没有」，没有中间态。
  */
  assert.deepEqual(computeColumns(979, 280, 700), { sidebar: 280, center: 699, rightbar: 0 })
})

test('让步第三步：只有在没有轨道之后，中栏才被允许掉到 400 以下，一直到 0', () => {
  assert.deepEqual(computeColumns(600, 280, 700), { sidebar: 280, center: 320, rightbar: 0 })
  assert.deepEqual(computeColumns(300, 280, 700), { sidebar: 280, center: 20, rightbar: 0 })
  // 框比左栏还窄：中栏见底，**左栏仍然是 280**，见下一条。
  assert.deepEqual(computeColumns(200, 280, 700), { sidebar: 280, center: 0, rightbar: 0 })
})

test('左栏永不让步：任何框宽下它都等于自己的偏好（折叠由外面的断点决定，不由这里）', () => {
  for (const viewport of [2400, 1600, 1024, 1023, 980, 700, 400, 200, 100]) {
    assert.equal(computeColumns(viewport, 360, 700).sidebar, 360, `框宽 ${String(viewport)} 时左栏让步了`)
    assert.equal(computeColumns(viewport, 0, 700).sidebar, SIDEBAR_COLLAPSED, `框宽 ${String(viewport)} 时收起的轨变了`)
  }
})

test('性质：整个宽度区间上，只要右栏还有轨道，中栏就不低于 400', () => {
  /*
    上面那三条是采样，这条是覆盖。顺序坏掉最可能的形态是「某个区间里右栏和中栏同时妥协」，
    而那种 bug 只在几十个像素宽的窗口里出现，采样很容易正好跳过去。
  */
  for (let viewport = 100; viewport <= 2600; viewport += 1) {
    for (const sidebar of [0, SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX]) {
      for (const rightbar of [0, RIGHTBAR_MIN, 480, 900, 9999]) {
        const cols = computeColumns(viewport, sidebar, rightbar)
        const expectedSidebar = sidebar === 0 ? SIDEBAR_COLLAPSED : sidebar
        assert.equal(cols.sidebar, expectedSidebar)
        assert.ok(cols.center >= 0 && cols.rightbar >= 0)
        if (cols.rightbar > 0) {
          assert.ok(cols.rightbar >= RIGHTBAR_MIN, `${String(viewport)}: 右栏被压到了 ${String(cols.rightbar)}，比下限还窄`)
          assert.ok(cols.center >= CENTER_MIN, `${String(viewport)}: 还留着轨道就让中栏掉到了 ${String(cols.center)}`)
          assert.ok(cols.rightbar <= viewport * RIGHTBAR_MAX_RATIO)
        }
        // 三栏加起来要么正好铺满框，要么框比左栏还窄（中栏见底、左栏不让）。
        const total = cols.sidebar + cols.center + cols.rightbar
        assert.ok(total === viewport || (cols.center === 0 && total >= viewport))
      }
    }
  }
})

import { initLayout } from '../src/vendor/dsh/layout/layout-state.ts';

/*
  **窄窗口不许改掉存下来的右栏偏好。**

  这里曾经按当前视口夹上界。后果是：在一个窄窗口里打开一次页面，存的 648 被夹成 300，
  而持久化那一侧跟着把 300 写回去——再拉回宽屏，右栏永远停在 300。一次临时的窗口大小
  把偏好抹掉了。上界该由渲染时的 computeColumns 按当前视口夹，那是它的活。
*/
test('a narrow viewport must not shrink the stored rightbar preference', () => {
  const stored = { sidebar: 280, rightbar: 648 };
  assert.equal(initLayout(stored, 400).rightbar, 648, '窄窗口只是当下画不下，不该改掉偏好');
  assert.equal(initLayout(stored, 1920).rightbar, 648);
  // 下界仍然守着：比自己下限还窄的值是旧版本或手改留下的。
  assert.equal(initLayout({ sidebar: 280, rightbar: 120 }, 1920).rightbar, RIGHTBAR_MIN);
  // 不是有限数就当没存过。
  assert.equal(initLayout({ sidebar: 280, rightbar: Number.NaN }, 1920).rightbar, null);
});

/*
  **对话模式下终端那一栏的默认宽度，是按契约算的，不是拍一个比例。**

  上游的 `RIGHTBAR_DEFAULT_RATIO = 0.45` 对我们不成立：它那条栏装的是文件树这类看一眼就走
  的东西，我们这一栏装终端，而中栏是被定为主角的对话。实测 0.45 在 1440 上给对话只剩
  468px（代码块折行、表格压扁），终端拿走 612。

  改成「先给对话喂满内容轴下限 680，剩下的全给终端」。放不下 RIGHTBAR_MIN 就该默认收起。
*/
test('the terminal seat takes what is left after the conversation gets its content axis', () => {
  const RAILS = 80, CONTENT_MIN = 680;
  const width = (viewport: number) => viewport - RAILS - SIDEBAR_DEFAULT - CONTENT_MIN;

  // 1280：算出来 240 < 300，两者不可兼得 → 默认收起，对话独占。
  assert.ok(width(1280) < RIGHTBAR_MIN, `1280 只剩 ${width(1280)}，放不下`);
  // 1340 是那个分界：正好 300。
  assert.equal(width(1340), RIGHTBAR_MIN);
  // 1440：终端 400px（13px 等宽约 46 列），而对话拿满 680。
  assert.equal(width(1440), 400);
  const roomy = computeColumns(1440 - RAILS, SIDEBAR_DEFAULT, width(1440));
  assert.equal(roomy.center, CONTENT_MIN, '对话该正好拿到内容轴下限');
  assert.equal(roomy.rightbar, 400);

  // 反证上游那个比例为什么不能用：同样 1440，中栏掉到 468。
  const byRatio = computeColumns(1440 - RAILS, SIDEBAR_DEFAULT, (1440 - RAILS) * 0.45);
  assert.ok(byRatio.center < CONTENT_MIN, `0.45 会让中栏掉到 ${byRatio.center}`);
});
