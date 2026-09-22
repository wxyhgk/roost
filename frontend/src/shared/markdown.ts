import { useEffect, type RefObject } from "react";
import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
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
export function renderMarkdown(content: string, customize?: (md: InstanceType<typeof MarkdownIt>) => void): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  md.use(katex, { delimiters: "all", mathFence: true, throwOnError: false });
  customize?.(md);
  return md.render(content);
}

/**
 * 围栏代码块的高亮。
 *
 * markdown-it 的 highlight 回调是同步的、而 shiki 是异步的，所以先渲染出朴素的
 * `<pre><code>`，挂载之后再逐个替换。
 */
export function useCodeHighlight(host: RefObject<HTMLElement | null>, html: string, theme: string) {
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
  }, [host, html, theme]);
}
