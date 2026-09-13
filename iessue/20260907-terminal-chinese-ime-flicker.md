# 终端中文输入组词文字向左跳动、闪烁

- 日期：2026-09-07
- 状态：已修复，用户实际中文输入确认通过（“可以了”）。
- 范围：前端 xterm 输入法定位；不涉及后端、PTY 重启或 CLI 配置。

## 现象

使用中文输入法时，尚未提交的组词文字会在画面左侧闪烁、跳动。

## 根因与证据

项目的 `attachTuiIme` 将 textarea 和 `.composition-view` 设为 `position: fixed`，使用屏幕坐标定位，并在输入事件及动画帧中反复更新。

xterm 自身也会更新相同元素：

- `CompositionHelper.updateCompositionElements()` 在组词期间写入 `style.left/top` 等属性，坐标相对于终端内部。
- `CoreBrowserTerminal` 也会同步 textarea 的位置和尺寸。

原补丁把 `!important` 直接写在内联定位属性上，但后续 `element.style.left = ...` 会替换该属性及其优先级。因此，固定定位保留着，坐标却被改成终端内部坐标；下一次补丁刷新又恢复成屏幕坐标，两套定位交替覆盖，造成向左跳动和闪烁。

此外，TUI 后台重绘可能临时移动终端光标。组词中持续跟随该光标，会使输入法位置不稳定。

## 修复

1. `frontend/src/terminal/ime.ts`：只写独立的 `--ime-*` CSS 变量，以 `.diy-ime-anchor` 标记定位归属，不再与 xterm 争写 `left/top`。
2. `frontend/src/terminal/ime.css`：通过样式表中的 `!important` 规则读取上述变量，让 textarea 与组词浮层始终使用一致的坐标系。xterm 的普通内联赋值无法覆盖该定位规则。
3. `frontend/src/terminal/xtermEngine.ts`：在 xterm 原生样式之后加载输入法定位样式。
4. 一次 `compositionstart` 到 `compositionend` 期间固定光标单元格，结束后恢复跟随；窗口布局变化仍重新计算对应屏幕位置。
5. 移除 textarea 与 root 对同一冒泡组词事件的重复监听；清理时移除补丁类和自有变量，保留 xterm 自身的内联样式。

未接管中文文本提交逻辑，组词和提交仍由 xterm 处理。

## 验证

回归页面：`frontend/tests/browser/terminal-ime.html`。

通过 Vite 打开 `/tests/browser/terminal-ime.html`，点击“验证中文组词定位”。页面使用真实 xterm 和模拟 CompositionEvent，不连接用户 PTY。

- 连续 `n → ni → nih → nihao` 组词，事件当下及下一动画帧中，两种输入法元素的位置均稳定。
- 组词期间模拟 TUI 输出并移动光标，输入法位置不跳动。
- 组词结束后恢复跟随光标；失焦后移除定位补丁。
- 浏览器结果：`passed: true`。
- 前端类型检查和生产构建通过；工作区边界检查、`git diff --check` 通过。
- 自动化检查不等同于原生输入法验收；随后用户实际输入确认问题已解决。

## 后续维护

不要恢复为“内联 fixed 定位 + 反复写 left/top”的方案。升级 xterm 或改动终端布局时，重跑上述回归，并实际测试中文候选窗、组词提交和连续输入。尤其注意不要混用屏幕坐标与终端内部坐标。
