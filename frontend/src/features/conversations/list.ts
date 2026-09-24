import type { Conversation, ConversationFilters } from "../../shared/api/conversations";

/**
 * 对话列表的翻页状态。
 *
 * 这里唯一容易写错的是**游标与筛选条件绑定**：后端把 state / projectId / q 哈希进
 * 游标的 scope，条件一变旧游标就会被判成 400 "cursor does not match"。所以筛选
 * 一改必须把游标和已加载的条目一起丢掉，从头再来——留着任何一半都是错的。
 *
 * 逻辑抽成纯归约，因为这条规则测得到，而写在组件里测不到。
 */

export type ListState = {
  items: Conversation[];
  cursor: string | null;
  /** 已经翻到底了。null 游标既表示「还没开始」也表示「到底了」，得单独记。 */
  done: boolean;
  loading: boolean;
  error: string | null;
  filters: ConversationFilters;
};

export const emptyList = (filters: ConversationFilters = {}): ListState =>
  ({ items: [], cursor: null, done: false, loading: false, error: null, filters });

export type ListAction =
  | { type: "filter"; filters: ConversationFilters }
  | { type: "loading" }
  | { type: "page"; items: Conversation[]; nextCursor: string | null; append: boolean }
  /**
   * 详情里改完了（改名、置顶、换分组），把列表里那一行换成服务端刚返回的记录。
   *
   * **列表那一份不换掉不只是「标题显示成旧的」**：`ConversationList` 再点同一行时，
   * 传给详情的是列表里这个对象，它带着**旧的 revision**——下一次改任何一项都会先撞一次
   * 409「别处刚改过」，而其实是自己刚改的。
   */
  | { type: "replace"; conversation: Conversation }
  | { type: "failed"; message: string };

const sameFilters = (a: ConversationFilters, b: ConversationFilters) =>
  (a.q ?? "") === (b.q ?? "") && (a.state ?? "active") === (b.state ?? "active")
  && (a.projectId ?? undefined) === (b.projectId ?? undefined)
  && (a.terminalId ?? undefined) === (b.terminalId ?? undefined)
  // sort 也参与游标 scope：换排序必须从第一页重来。
  && (a.sort ?? "created") === (b.sort ?? "created");

export function reduceList(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "filter":
      // 条件没变就别把已加载的内容丢掉——输入框每敲一下都重置会让列表一直在闪。
      if (sameFilters(state.filters, action.filters)) return state;
      return { ...emptyList(action.filters), loading: true };
    case "loading":
      return { ...state, loading: true, error: null };
    case "page":
      return {
        ...state,
        items: action.append ? [...state.items, ...action.items] : action.items,
        cursor: action.nextCursor,
        done: action.nextCursor === null,
        loading: false,
        error: null,
      };
    case "replace": {
      const at = state.items.findIndex(item => item.id === action.conversation.id);
      /*
        列表里没有这一行就什么都不做，**不要顺手插进去**：它可能压根不属于当前的筛选结果
        （比如搜索「报错」时从别处打开了一条），插进去等于往一个筛过的列表里塞一条不匹配的。
      */
      if (at === -1) return state;
      const items = state.items.slice();
      items[at] = action.conversation;
      // 位置不动。这里唯一会影响排序的只有置顶，而排序是按 activity 的，置顶本来就不参与；
      // 就算参与，让一行在用户刚点过它的位置上跳走也是更糟的那个选择。
      return { ...state, items };
    }
    case "failed":
      return { ...state, loading: false, error: action.message };
  }
}
