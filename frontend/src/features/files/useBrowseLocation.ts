import { useCallback, useEffect, useRef, useState } from "react";
import { locationKey, readLocation, writeLocation, type BrowseLocation } from "./browseLocation";

/**
 * 文件面板当前浏览到哪儿，以及切换时该做什么。
 *
 * 换根目录会作废已浏览的子路径，但**保留你选的 树/列表 偏好**——那是关于你怎么看
 * 文件的习惯，跟看哪个目录无关。
 *
 * `onLeave` 在每次「换了地方」时调用一次（导航、换模式、换根目录）。抽出这个回调
 * 是因为原来这三处各自抄了一遍「清空搜索词、退出新建状态、清掉错误」，抄了三份。
 */
export function useBrowseLocation(sessionId: string, root: string, onLeave: () => void) {
  const key = locationKey(sessionId, root);
  const [location, setLocation] = useState<BrowseLocation>(
    () => readLocation(key) ?? { mode: "tree", path: "" });

  // 这几个都从 ref 读，好让下面的回调保持恒定：回调一变，下游那个 effect 就会反复重挂。
  const latest = useRef({ key, location, onLeave });
  latest.current = { key, location, onLeave };

  const rememberFile = useCallback((file: string | null) => {
    writeLocation(latest.current.key, { ...latest.current.location, file });
  }, []);

  const known = useRef(key);
  useEffect(() => {
    if (known.current === key) return;
    known.current = key;
    setLocation(previous => readLocation(key) ?? { mode: previous.mode, path: "" });
    latest.current.onLeave();
  }, [key]);

  const move = useCallback((patch: Partial<BrowseLocation>) => {
    const next = { ...latest.current.location, ...patch };
    writeLocation(latest.current.key, next);
    setLocation(next);
    latest.current.onLeave();
  }, []);

  return {
    location,
    navigate: useCallback((path: string) => move({ path }), [move]),
    changeMode: useCallback((mode: BrowseLocation["mode"]) => move({ mode }), [move]),
    rememberFile,
  };
}
