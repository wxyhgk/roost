# vendor/dsh —— 来自 deepseek-harness 的 UI 积木

## 许可

MIT License

Copyright (c) 2026 DeepSeek

上游：<https://github.com/deepseek-ai/deepseek-harness>
路径：`packages/client/ui-primitives/src/`
检出提交：`0d1f500`

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 这份拷贝的规矩

**除下面点名的四个文件外，每个文件都逐字取自上游**，顶上压着一行出处（路径 + 提交号）。
这样做是为了将来还能重新同步：改动只要还锁在那四个文件里，重新拉一遍上游就是覆盖，
而不是一场三方合并。要改样式请改 `tokens.css`，不要改进 `*.module.css`。

### 不是上游的四个文件

| 文件 | 是什么 |
| --- | --- |
| `NOTICE.md` | 本文件 |
| `index.ts` | 上游 `index.ts` 删到只剩留下那批之后的版本 |
| `tokens.css` | `--dsw-*` → 我们 `--color-*` 的桥接表，文件里标了哪些值是猜的 |
| `markdown/MarkdownText.tsx` | **我们自己写的纯文本替身**，理由写在文件头 |

### 逐字之外的两处改动

1. **`ansi.ts` / `head-tail-cap.ts` 不在这个目录里。** `TerminalBlock.tsx` 和
   `SearchBlock.tsx` 改指 `frontend/src/shared/terminal-text/` 下已有的那一份——两条
   import 行，旁边标了 `ROOST-CHANGE`。那份拷贝的颜色映射换成了我们的主题令牌（所以它
   **不**逐字，不适合放进这个目录），配套测试是 `frontend/tests/ansi.test.ts`，75 个用例。
   搬第二份的代价是两份会各自漂移，而测试只钉着其中一份。
2. **`markdown/MarkdownText.tsx` 是替身，不是上游实现。** 见该文件头部：上游那棵树约
   1800 行、外带 8 个我们没装的 npm 包（含 katex），而它在这批积木里唯一的消费方是
   `WebBlock` 里 web_search 的那段 answer。

## 搬了什么

`DiffBlock` `TerminalBlock` `ReadBlock` `SearchBlock` `WebBlock` `CodeBlock` `JsonBlock`
`DisclosureRow` `StateDot` `Pill` `FoldToggle`，以及它们的依赖闭包：

- 工具：`clipboard.ts`、`use-copy-feedback.ts`、`css-modules.d.ts`
- 语法高亮：`markdown/highlight.ts`、`markdown/useViewportHighlighting.ts`（走 `shiki`）
- 图标：`icons/index.tsx`、`icons/props.ts`（`DisclosureRow` 要 `IconChevronDownOutline14`）
- `WebBlock` 的链接图标一路：`LinkIcon.tsx` → `FileTypeIcon.tsx` → `CodeFileIcon.tsx`
  → `code-file-icon-artwork.ts` + `.manifest.json` + `code-file-types.ts`
  （`.manifest.json` 不能写注释，出处只记在这里）

## 没搬什么

上游有、这里故意不要的（搬之前 grep 过，留下的文件没有任何一个引用它们）：

- 品牌与外壳：`BrandWordmark` `FishLogo` `ConnectionIndicator` `OnboardingSurface`
- 通用控件：`Button` `Input` `Switch` `Tag` `Menu` `Modal` `Toast` `Tooltip`
  `HoverCard` `RiskConfirmation` `JsonTree` `ReferenceIcon` `user-text`
- 定位与杂项 hook：`useAnchoredMaxHeight` `useAnchoredPosition`
  `useDismissOnOutsidePointer` `pointer-grace` `relative-time` `rank-by-name` `file-size`
- markdown 渲染树：`markdown/` 下的 `MarkdownText`（换成替身）`render` `parse`
  `incremental` `cjkFriendlyStrong` `mathCompatibility` `katex` `plain-text`

## 运行时依赖

`react`、`clsx`、`diff`、`anser`、`shiki`（`@shikijs/langs` 由 `shiki` 带入）。
`clsx` 和 `diff` 是为这次 vendor 加进 `frontend/package.json` 的。
