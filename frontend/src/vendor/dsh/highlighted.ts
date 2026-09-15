/*
  vendor/dsh 里**会拖进 shiki 的那两块**，单独一个入口。

  `markdown/highlight.ts` 静态 import 了 shiki 核心和 typescript/shellscript/json 三个语法，
  顶上还有一行 `setTimeout(() => highlighter(), 0)` 的预热——有顶层副作用，打包器摇不掉。
  实测混在主桶里时，只取一个 `TerminalBlock` 也会把 shiki 一起拖走（29 处、708 KB）。

  分出来不是洁癖：我们自己的 `shared/code-highlight.ts` 是懒加载 shiki 的，首屏体积上量过。
  要代码高亮的地方**显式从这里拿**，并且自己决定要不要 lazy——别让一个不相干的积木替它做主。

  这个文件不是抄来的，是我们为了隔离副作用而拆的。
*/
import './tokens.css'

export { ReadBlock, DEFAULT_READ_MAX_LINES } from './ReadBlock.tsx'
export type { ReadBlockProps, ReadBlockLine, ReadBlockLabels } from './ReadBlock.tsx'
export { CodeBlock } from './markdown/CodeBlock.tsx'
export type { CodeBlockProps } from './markdown/CodeBlock.tsx'
