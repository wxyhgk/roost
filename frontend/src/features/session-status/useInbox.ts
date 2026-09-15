import { useCallback, useRef, useSyncExternalStore } from "react";
import { sessionStatus } from "./runtime";
import { selectInbox, type InboxItem } from "./inbox";

/*
  订阅和读取都只依赖 id 集合本身；数组每次渲染都是新的，用它的内容做键。
  和 useGroupActivity 里同一个处理，理由也一样。
*/
function useIds(sessionIds: string[]) {
  const key = sessionIds.join(",");
  const subscribe = useCallback((notify: () => void) => {
    const stop = key ? key.split(",").map(id => sessionStatus.subscribe(id, notify)) : [];
    return () => { for (const cancel of stop) cancel(); };
  }, [key]);
  return { key, subscribe };
}

const readInbox = (key: string) =>
  selectInbox((key ? key.split(",") : []).map(id => ({ id, view: sessionStatus.read(id) })));

const EMPTY: InboxItem[] = [];

/**
 * 在等你的那些会话。
 *
 * **必须缓存快照。** `useSyncExternalStore` 每次渲染都调 getSnapshot 并和上次比引用，
 * 而这里的返回值是个数组——每次新建就会被判成「变了」，然后无限重渲染。
 * `useGroupActivity` 是靠「只回一个原始类型」绕开的，收件箱回不了原始类型，所以改成
 * 序列化成签名：内容没变就返回上一次那个数组。
 *
 * 用 JSON.stringify 当签名，是因为 InboxItem 全是标量字段，序列化结果和「内容变没变」
 * 严格一一对应——自己拼一个分隔符反而要操心值里出现分隔符的情况。
 */
export function useInbox(sessionIds: string[]): InboxItem[] {
  const { key, subscribe } = useIds(sessionIds);
  const cache = useRef<{ signature: string; items: InboxItem[] }>({ signature: "[]", items: EMPTY });

  const read = useCallback((): InboxItem[] => {
    const items = readInbox(key);
    const signature = JSON.stringify(items);
    if (signature !== cache.current.signature) cache.current = { signature, items };
    return cache.current.items;
  }, [key]);

  return useSyncExternalStore(subscribe, read, read);
}

/**
 * 只要个数（左栏那个角标）。
 *
 * 单独一个 hook 而不是 `useInbox(ids).length`：数字是原始类型，不必缓存快照，
 * 而角标挂在一个每次工作区变化都会重渲染的位置上。
 */
export function useInboxCount(sessionIds: string[]): number {
  const { key, subscribe } = useIds(sessionIds);
  const read = useCallback(() => readInbox(key).length, [key]);
  return useSyncExternalStore(subscribe, read, read);
}
