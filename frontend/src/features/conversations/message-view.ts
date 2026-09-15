/*
  一条文字消息「画成什么」。

  **单独一个纯 .ts 文件，是为了能测。** 这个判断原来藏在 ConversationDetail 的
  `TextBlock` 里，写成两个相互嵌套的布尔（`mine = role === "user"`、
  `prose = !mine && role !== "tool"`）散在 className 的模板串中间——三条分支哪条走哪条
  一眼看不出来，更没有一行测试钉着它。而现在这个判断的后果变重了：它决定一条消息是走
  上游的 `MessageItem`（气泡 / 正文两支），还是留在我们自己那支原样底框里。

  `frontend/tests` 没有 jsdom，`node --test` 也加载不了 CSS Module，所以**凡是要被测的
  判断都必须落在不 import 任何 CSS/JSX 的模块里**。这个文件因此零 import。

  角色本身是**传输的外壳**，不是「谁在说话」——解析器给什么就是什么（`user` /
  `assistant` / `tool` / `system` / 以及将来某个 CLI 自创的词）。收敛成三种画法之后，
  调用方不必再认识角色这个开放集合。
*/

/**
 * 三种画法。
 *
 * - `bubble`：右对齐的用户气泡（上游 `MessageItem role="user"`）。底色
 *   `--dsw-specific-bubble`，宽度跟 `--dsh-chat-content-width` 联动。
 * - `prose`：不套气泡的正文，按 markdown 渲染（上游 `MessageItem role="assistant"`）。
 * - `mono`：原样底框 + 长文折叠。**上游没有对应视图**，所以这一支留着我们自己的。
 *   它接的是 `role === "tool"` 那种直接落进消息流的原始工具文本：按 markdown 渲染会
 *   把路径里的下划线、日志里的星号当成排版指令，读起来比纯文本更糟。
 *   （名字里的 mono 指的是 `white-space: pre-wrap` 这层「原样」，**不是换了等宽字族**
 *   ——换掉之前的 `TextBlock` 也没换字族，这一支是逐字保留它。）
 */
export type MessageView = "bubble" | "prose" | "mono";

/**
 * 角色 → 画法。
 *
 * 判据和换掉之前的 `TextBlock` **逐条等价**：
 * `mine === (messageView(role) === "bubble")`、`prose === (messageView(role) === "prose")`，
 * 剩下的 `tool` 落在 `mono`。`conversation-message-view.test.ts` 把这个等价关系钉住了。
 *
 * 认不出来的角色一律走 `prose`——和旧代码一致（`!mine && role !== "tool"` 对任何生面孔
 * 都成立）。往「像正文一样画」那边倒是安全的一侧：最坏是给一段纯文本多排了一次版，
 * 而倒向气泡会让一条不是用户说的话顶着「你」的样子出现在右边。
 */
export function messageView(role: string): MessageView {
  if (role === "user") return "bubble";
  if (role === "tool") return "mono";
  return "prose";
}

/**
 * 这种画法要不要在内容过长时折起来。
 *
 * **只有 `mono` 折。** 这条折叠是纯文本时代的设计（>4 行或 >240 字就掐成四行），正文
 * 改成结构化渲染之后它对 `prose` 反而有害：掐掉的恰恰是表格、代码块、列表这些最有信息
 * 的部分，只留下开头两行散文。上游的助手回复根本不折叠，长回合靠「回合过程折叠」解决。
 * 气泡也不折——用户自己说过的话被掐断是最难接受的一种。
 */
export function foldsWhenLong(view: MessageView): boolean {
  return view === "mono";
}
