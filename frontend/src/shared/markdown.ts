import { useEffect, type RefObject } from "react";
import MarkdownIt from "markdown-it";
import { tex } from "@mdit/plugin-tex";
import { highlightCode } from "./code-highlight";

/**
 * Markdown 渲染的可复用内核：出 HTML，再异步把代码块换成高亮版本。
 *
 * **抽出来是因为它有两个用处**：文件预览插件，和对话里的 AI 回复。而特性目录不许
 * import 插件（见 check-boundaries 的插件规则），所以共用的部分必须站在 shared 里。
 * 文件相关的东西——图片相对路径改写、文件链接跳转——留在插件里，那些不是共用的。
 */

/**
 * `html: false` 是默认值，显式写出来是因为它是这里的关键取舍：
 * 文档里的原始 HTML 按文本显示，而不是塞进页面。理由不是防谁，而是**布局稳定**——
 * 一段没闭合的 `<div>` 或一个 `<style>` 足以把整个面板搞乱，而无论是文件预览还是
 * AI 回复，都没有任何理由需要执行内容里的 HTML。
 */
/*
  数学公式。四种写法全开，外加 ```math 围栏。

  **`$…$` 那一档原本我打算关掉，量错了一次。** 第一次扫 .md 原文，数到 4 处 shell 变量
  （`--run "$sender_conversation_id" …`）会被行内数学规则吃掉，于是判定单 `$` 对这个
  仓库不安全。复查才发现**那 4 处全在代码围栏里**——markdown-it 从不对围栏内容套行内
  规则，散文里真正会被误吃的是 **0 处**。原始文本的统计不等于渲染时的风险。

  **KaTeX 的 CSS 不在这里 import，在挂载方那边**（`plugins/markdown/markdown.tsx` 和
  `features/conversations/ConversationDetail.tsx`），和这个仓库其余 CSS 的放法一致：
  这个文件要能在纯 node 里测，而 node 加载不了 `.css`。

  代价是「新增一个消费者、忘了 import CSS」会出现「公式渲染了但排版是散的」这种半吊子
  状态。那条配对由 `tests/markdown-math.test.ts` 的最后一条用例守着——它扫源码，
  谁 import 了 renderMarkdown 就必须一起 import katex 的 CSS。

  `throwOnError: false` —— 写错的公式显示成红色原文，而不是把整篇文档炸掉。
  这和上面 `html: false` 的理由是同一条：**渲染内容的失败不该毁掉容器**。
*/
/** 公式先出占位，挂载后再换成真的。类名是 `useMathRender` 的唯一入口。 */
export const MATH_PENDING = "math-pending";
const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderMarkdown(content: string, customize?: (md: InstanceType<typeof MarkdownIt>) => void): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  /*
    **这里只认出公式，不渲染它。**

    渲染要 katex，而 katex 是 365 KB（gzip 119）。它原来通过 `@mdit/plugin-katex` 被静态
    引进来，于是每次打开对话面板都要先下完它——实测那一跳占了整个二次下载的七成以上，
    而绝大多数对话里一个公式都没有。

    所以换成和代码高亮同一套做法（见 `useCodeHighlight`）：这一步同步出一个占位 span，
    挂载之后由 `useMathRender` 决定要不要去取 katex。**没有公式就一个字节都不下。**

    TeX 原文放在占位的文本内容里而不是属性里——属性要多一层转义，而文本内容读回来就是原文。
  */
  md.use(tex, {
    delimiters: "all", mathFence: true,
    render: (source, displayMode) =>
      `<span class="${MATH_PENDING}"${displayMode ? ' data-display="1"' : ""}>${escapeHtml(source)}</span>`,
  });
  customize?.(md);
  return md.render(content);
}

/**
 * 把占位换成真公式。**只有页面上确实有公式时才去取 katex。**
 *
 * 和 `useCodeHighlight` 是同一条纪律：同步那一步只出朴素结构，重的东西挂载之后按需拉。
 * 样式也一起动态取——CSS 和渲染结果是配对的，缺了它公式会散成一行看不懂的字符。
 */
export function useMathRender(host: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const pending = [...root.querySelectorAll(`.${MATH_PENDING}`)] as HTMLElement[];
    if (!pending.length) return;
    let cancelled = false;
    void (async () => {
      const [{ default: katex }] = await Promise.all([
        import("katex"),
        import("katex/dist/katex.min.css"),
      ]);
      if (cancelled) return;
      for (const node of pending) {
        if (!node.isConnected) continue;
        const holder = document.createElement("span");
        // `throwOnError: false`：写坏的公式显示成红色原文，不把整篇文档炸掉。
        holder.innerHTML = katex.renderToString(node.textContent ?? "", {
          displayMode: node.dataset.display === "1", throwOnError: false,
        });
        node.replaceWith(holder);
      }
    })();
    return () => { cancelled = true; };
    /*
      **没有依赖数组是有意的：这个 effect 必须在每次提交后都跑一遍。**

      它在 React 之外改 DOM（把占位 span 换成 katex 输出），而 React 并不知道这件事。
      只要 React 因为任何原因重写一次 `dangerouslySetInnerHTML`——即使 `html` 一个字节
      都没变——我们插进去的公式就被整块冲掉，DOM 退回占位版；而依赖写成 `[host, html]`
      时这个 effect 不会重跑，于是公式**永久**停在占位上，不报错、不自愈。

      实测（2026-09-25，文件面板的 .md 预览）：把浏览器窗口拖到另一块缩放不同的显示器上，
      `devicePixelRatio` 变化引发一次重渲染，20 个已渲染的公式全部退回 21 个占位，之后
      改回原来的缩放、改窗口宽度都救不回来。给元素的 innerHTML setter 下断点抓到的调用栈
      是 React 的 commit 阶段，控制台没有任何报错。

      每次提交都跑的代价是一次 `querySelectorAll`：没有占位就立刻返回，已经渲染好的文档
      走的就是这条空路。比起「偶尔永久性地不渲染公式」，这个代价可以忽略。
    */
  });
}

/**
 * 围栏代码块的高亮。
 *
 * markdown-it 的 highlight 回调是同步的、而 shiki 是异步的，所以先渲染出朴素的
 * `<pre><code>`，挂载之后再逐个替换。
 */
export function useCodeHighlight(host: RefObject<HTMLElement | null>, theme: string) {
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let cancelled = false;
    const blocks = [...root.querySelectorAll("pre > code")] as HTMLElement[];
    void Promise.all(blocks.map(async block => {
      const lang = [...block.classList].find(name => name.startsWith("language-"))?.slice(9);
      if (!lang) return;
      // highlightCode 按文件名判语言，这里用围栏上的语言拼一个假文件名喂给它。
      const marked = await highlightCode(block.textContent ?? "", `block.${lang}`, theme);
      if (cancelled || !marked) return;
      const pre = block.parentElement;
      if (!pre?.isConnected) return;
      const holder = document.createElement("div");
      holder.className = "code-highlight";
      holder.innerHTML = marked;
      pre.replaceWith(holder);
    }));
    return () => { cancelled = true; };
    // 同上：代码块也是在 React 之外替换的，同样会被一次重写抹掉。高亮完之后
    // `pre > code` 就不存在了，所以重跑的代价同样是一次落空的查询。
  });
}
