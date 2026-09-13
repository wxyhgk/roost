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
    case "failed":
      return { ...state, loading: false, error: action.message };
  }
}
