import type { WorkspaceSnapshot } from "../api";

// 远程同步策略（store 的 UI 状态不动，只收敛“失败怎么办”）：
// fire-and-forget 的写操作失败 → 回滚到写之前的本地快照 + 报错。
// 不走网络：写失败最常见的原因（后端已停）同样会让重拉失败，那时什么都恢复不了。
export type SyncDispatch = (action:
  | { type: "hydrate"; data: WorkspaceSnapshot }
  | { type: "markStale" }
  | { type: "setError"; message: string | null }) => void;

// 乐观写：先本地生效，失败回滚。before 是写之前的快照，调用方在 dispatch 前取。
export function syncOptimistic(promise: Promise<unknown>, dispatch: SyncDispatch, message: string, before: WorkspaceSnapshot) {
  void promise.catch(() => {
    // hydrate 会清空 error，所以先回滚再报错，否则提示会被自己抹掉。
    dispatch({ type: "hydrate", data: before });
    /*
      **回滚之后必须跟服务端重新对一次账。** 回滚的是整份快照，而常规轮询只补
      cwd/cli/cliId 三个字段；这中间别的操作改过的标题、分组、排序会被一起抹掉且永不
      恢复。打个记号，让下一次轮询走全量合并。理由全文见 `state.ts` 的 `needsFullRead`。
    */
    dispatch({ type: "markStale" });
    dispatch({ type: "setError", message });
  });
}

// 悲观写：成功无分叉，失败只报错（fallback 给未知错误托底）。
export function failRemote(dispatch: SyncDispatch, err: unknown, fallback: string) {
  dispatch({ type: "setError", message: err instanceof Error ? err.message : fallback });
}
