# vendor/happier —— 来自 happier 的纯逻辑

## 为什么这里另开一个目录（而不是塞进 `vendor/dsh/`）

搬运任务给的出处是「deepseek-harness，`ui-tool/.../shell/presentation/`，提交 `0d1f500`」，
**这一条不成立**：deepseek-harness 全仓没有 `presentation/` 这个目录，也没有
`resolveToolStatusIndicatorKind` / `resolveToolErrorSummary` 这两个名字（本机 grep 过）。
这两个文件实际出自 **happier**，`apps/ui/sources/components/tools/shell/presentation/`。
第一轮调研里提到「把 completed 其实失败了提前判掉」的也是 happier 那一篇
（`research/happier-gui-renderers.md` 结论第 2 条），不是 `research/deepseek-harness-ui.md`。

两家的版权人不是同一个（DeepSeek vs Happy Coder Contributors），而 `vendor/dsh/NOTICE.md`
写的是「除点名的四个文件外每个文件都逐字取自上游」——把别家的代码放进去，既会让那行
版权声明变成假话，也会毁掉「重新拉一遍上游就是覆盖」的重新同步前提。所以另开一个
vendor 根，目录尾巴仍按任务要的 `chat/tool/presentation/`。

## 许可

MIT License

Copyright (c) 2026 Happy Coder Contributors

上游：<https://github.com/happier-dev/happier>
路径：`apps/ui/sources/components/tools/shell/presentation/`
检出提交：`c4deb153e7d4740f06bfeee94b70cfda95d47068`（`LICENCE`，注意上游用的是英式拼写）

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## 这份拷贝的规矩

和 `vendor/dsh` 同一套：**逐字抄**，文件头写出处（路径 + 提交号），每一处改动就地标
`ROOST-CHANGE`。上游用 4 空格缩进、带分号、单引号，这里一并保留——**那是逐字的一部分**，
不要按仓库其余文件的风格「顺手改齐」，改齐了就没法再拿上游覆盖一遍。

## 搬了什么

| 文件 | 上游同名文件 | 在我们这儿的处境 |
| --- | --- | --- |
| `chat/tool/presentation/resolveToolErrorSummary.ts` | 逐字 + 2 处 ROOST-CHANGE | **在用**，经 `features/conversations/tools/error-summary.ts` 适配 |
| `chat/tool/presentation/resolveToolStatusIndicatorKind.ts` | 逐字 + 1 处 ROOST-CHANGE | **没接线**，见下 |

### `resolveToolStatusIndicatorKind` 为什么没接线

它在上游能干的事是「`state` 说 completed，但 result 里自己写着失败」。搬过来之后在我们的
数据上**一次也不会命中**，原因是那道 `isHappierToolsCallEnvelope` 闸门：递归挖 result 时，
只有当字符串解出来是 `{ v: 1, kind: 'tools_call' }` 这个 happier 自己的信封，才会继续往里挖
（`hasStructuredResultFailure` 的 string 分支）。我们的 `block.result` 是一坨**普通字符串**，
哪怕内容正好是 `{"ok": false}`，解出来也不是那个信封，于是直接 false。

所以它对我们的净收益是零，留在这里是**为了将来**：哪天解析器开始给结构化 result
（那正是 `research/deepseek-harness-ui.md` 结论第 2 条说的 `presentationMeta` 那条路），
这个函数连同它的深度上限和递归键名就现成可用。**在那之前不要为了用它而去构造假的信封。**

## 运行时依赖

`resolveToolErrorSummary` 要 `frontend/src/shared/terminal-text/ansi.ts`（它自己拖 `anser`）。
和 `vendor/dsh/NOTICE.md` 里 `TerminalBlock.tsx` 指向 shared 的那条是同一个做法、同一个理由：
不搬第二份 ansi，两份会各自漂移而测试只钉着其中一份。
