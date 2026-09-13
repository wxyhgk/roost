import { useCallback, useSyncExternalStore } from 'react';
import { sessionStatus } from './runtime';

/**
 * 一个工作区里所有终端合起来的状态，按「有多需要你」排序取最紧的那个。
 *
 * blocked 永远压倒一切：一屏工作区里只要有一个 AI 在等你批准，那就是你该先看的
 * 那一个，不能被旁边正在刷屏的终端盖过去。
 */
export type GroupActivity = 'blocked' | 'active' | 'quiet' | 'none';

/**
 * **返回值必须是原始类型。** useSyncExternalStore 每次渲染都会调 getSnapshot 并和
 * 上次比较，返回新对象会被判成「变了」，然后无限重渲染。所以这里只回一个字符串。
 */
export function useGroupActivity(sessionIds: string[]): GroupActivity {
  // 订阅和读取都只依赖 id 集合本身；数组每次渲染都是新的，用它的内容做键。
  const key = sessionIds.join(',');

  const subscribe = useCallback((notify: () => void) => {
    const stop = key ? key.split(',').map(id => sessionStatus.subscribe(id, notify)) : [];
    return () => { for (const cancel of stop) cancel(); };
  }, [key]);

  const read = useCallback((): GroupActivity => {
    let best: GroupActivity = 'none';
    for (const id of key ? key.split(',') : []) {
      const view = sessionStatus.read(id);
      if (view.agent?.state === 'blocked') return 'blocked';
      if (view.state === 'active') best = 'active';
      else if (best === 'none') best = 'quiet';
    }
    return best;
  }, [key]);

  return useSyncExternalStore(subscribe, read, read);
}
