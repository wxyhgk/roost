/*
  对话的名字和归属从哪来。

  **对话的身份是 CLI 的 session id，这一点一直是对的**（`ai-history.ts` 的
  `conversationId = sha256(["local", cliId, nativeSessionId])`，`conversation_sources` 上还有
  `UNIQUE(origin_scope, cli_id, native_session_id)`）。换目录名、移仓库，身份都不变。

  **错的是元数据的来源：它是从终端一次性拍下来的快照。** 建对话那一刻，标题取当时那个
  终端的 title、归属取它的 project_id；而 `project_id` 此后再也不会更新。实测这台机器上
  21 条对话里 14 条标题是 `claude 3749983a-1594-47` 这种兜底值、10 条归属永远为空——
  三分之二的对话在被观测到的那一刻根本没有一个可用的终端。

  所以这一层的规则是：**凡是能从对话自己推出来的，就从对话自己推；推不出来才退回终端；
  而且每次观测都重算一次，不是一次性快照。**
*/

/** 标题的来源，优先级从高到低。数字大的赢。 */
export const TITLE_RANK = { fallback: 0, derived: 1, native: 2, user: 3 } as const;
export type TitleOrigin = keyof typeof TITLE_RANK;

/**
 * 从对话的第一条用户消息里推一个标题。
 *
 * **比 `claude 3749983a-1594-47` 强的全部理由**：那种名字在目录里长得一模一样，认不出
 * 哪条是哪条；而第一句问话几乎总是这段对话在讲什么。
 *
 * 它排在 `native`（终端的名字）**下面**：终端标题和对话标题要统一，是明确要过的行为，
 * 所以人给终端起了名字时以那个为准。这里只负责把兜底值换成一个有信息的默认名。
 */
export function deriveTitle(firstUserText: string | null | undefined, limit = 60): string | null {
  if (!firstUserText) return null;
  /*
    换行和连续空白压成一个空格：第一条消息经常是粘进去的一整段（报错、日志、代码），
    原样截断会把一行标题撑成三行，而那三行里没有一行说清了这是什么。
  */
  const flat = firstUserText.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // 代码块围栏、引用符这些开头的符号不带信息，去掉之后剩下的才是那句话。
  const cleaned = flat.replace(/^[>#*`\-\s]+/, "").trim();
  const text = cleaned || flat;
  if (text.length <= limit) return text;
  /*
    截断时尽量落在词或标点边界上，别把一个词劈成两半。找不到就硬截——
    中文没有空格，硬截在中文里本来就是正常的。
  */
  const cut = text.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("，"), cut.lastIndexOf("。"), cut.lastIndexOf("、"));
  return (boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + "…";
}

/**
 * 新标题该不该覆盖现有的。
 *
 * **同级要允许覆盖，否则终端改名之后对话标题就跟不上了**——那是明确要过的行为。
 * 只有更低一级的来源才挡住。
 */
export const titleWins = (incoming: TitleOrigin, current: TitleOrigin) =>
  TITLE_RANK[incoming] >= TITLE_RANK[current];

/**
 * 归属的来源。
 *
 * `title_origin` 那一套在归属上原来**没有对应物**，于是「这个分组是人自己选的，还是建
 * 对话时从终端捡来的」分不出来——而分不出来就不能重算，一重算就会把人手动的选择冲掉。
 * 所以单开一格。
 *
 * 存量数据迁移时：已经有值的一律当成 `user`（不知道来源就不动它），为空的当成
 * `derived`（本来就没有，填上只会变好）。
 */
export type ProjectOrigin = "derived" | "user";
