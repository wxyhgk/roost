/*
  **这个文件不是抄来的**，是我们为了把 KaTeX 从同步链路上摘下来而加的一层。

  上游 `katex.tsx` 顶上是 `import katex from 'katex'`，`MarkdownText.tsx` 顶上是
  `import 'katex/dist/katex.min.css'`——两条都是静态的，于是任何引到 MarkdownText 的
  chunk 都得连 KaTeX 一起下载。实测（内存构建 + gzip）：静态时会话详情那个
  chunk 是 JS 160.9 + CSS 12.2 KB gz，摘出来之后是 JS 85.4 + CSS 4.3——**KaTeX 一家
  83.6 KB gz**（引擎 75.7 + 样式表 7.9），而绝大多数消息里一条公式都没有。那 83.6 KB
  现在落在单独的 katex-lazy chunk 里，第一条公式出现时才去取。

  同样的纪律在这个 vendor 目录里已经写过两遍：`shared/code-highlight.ts` 懒加载 shiki，
  `vendor/dsh/index.ts` 为了不让 shiki 被静态拖进首屏把两块拆进了 `highlighted.ts`。

  引擎和样式表放在**同一个模块**里，是为了让 Vite 把它们打进同一个异步 chunk——CSS 会
  在这个 chunk 被加载时自动插入。分开写的话样式表会回到静态图里，白省一半。
*/
import 'katex/dist/katex.min.css'
export { default as katex } from 'katex'
