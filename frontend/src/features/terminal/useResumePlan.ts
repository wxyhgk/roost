import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { fetchResumePlan } from '../../shared/api/session';
import { createResumePlanQuery } from './resumePlanQuery';

/**
 * 终端退出后查询可恢复对话；暂时未就绪时有限重试，隐藏后停止。
 *
 * 只在死了并且这个终端正被看着的时候问：绑定关系随时会变（用户 /clear、换了 CLI），
 * 提前问到的答案在按钮被点到时早就过期了。真正说了算的是重开那一刻服务端再算的那次；
 * 这里的答案只决定按钮出不出现。
 */
export function useResumePlan(sessionId: string, enabled: boolean, revision = 0) {
  // Failed reopen invalidates the old plan even when React batches the two
  // restarting transitions, or the same error occurs twice.
  const query = useMemo(() => createResumePlanQuery(signal => fetchResumePlan(sessionId, signal)), [sessionId, revision]);
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot);
  useEffect(() => {
    const visibility = () => query.setActive(enabled && document.visibilityState !== 'hidden');
    visibility();
    window.addEventListener('online', query.refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('online', query.refresh);
      document.removeEventListener('visibilitychange', visibility);
      query.setActive(false);
    };
  }, [query, enabled]);
  return { ...state, refresh: query.refresh };
}
