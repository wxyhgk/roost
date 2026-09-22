import { useEffect, useState } from "react";

/*
  「线上已经换了一版，而你手上这个页面还是旧的。」

  资产按内容哈希、只增不删，所以旧页面永远能继续跑（见 deploy/publish.mjs 里那段顺序）。
  好处是发布不会打断任何人，代价是**旧页面会一直跑下去**：另一台设备上的浏览器抱着缓存里
  的旧外壳，直到有人手动硬刷。

  这不只是麻烦，是**会让人误判**的：忘了刷就以为改动没生效，然后去查一个根本不存在的
  bug。发布一次要提醒一次「记得硬刷」，而那一档永远靠人。

  所以让页面自己知道。**不自动重载**——你可能正在终端里打字，或者正在读一段刚跑完的输出，
  替你刷掉是更坏的结果。只给一个可以忽略的提示。
*/

/** 发布时写在外壳目录里，和 index.html 同级。 */
const MARKER = "/build.json";

/**
 * 两次查询之间至少隔这么久。
 *
 * 触发源是「页面重新可见」和「窗口获得焦点」，而这两件在切标签页时会连着来好几次。
 * 这个下限只是别把同一件事问四遍；它不影响察觉的及时性——你回到页面的那一刻就会查。
 */
const MIN_INTERVAL_MS = 10_000;

async function readBuildId(): Promise<string | null> {
  try {
    // 缓存正是这里要绕开的东西：拿到缓存里的旧戳，这套机制就永远不会响。
    const response = await fetch(MARKER, { cache: "no-store" });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    // 开发态没有这个文件，离线时也拿不到。两种都当「不知道」，绝不据此提示。
    return null;
  }
}

/**
 * 线上是不是已经换了一版。
 *
 * 开发态、拿不到基线、或者服务端没有这个文件时**恒为 false**——宁可不提示，
 * 也不要弹一个用户刷新之后还在的提示。
 */
export function useNewBuild(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let baseline: string | null = null;
    let last = 0;
    let disposed = false;

    const check = async () => {
      if (disposed || stale) return;
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) return;
      last = now;
      const id = await readBuildId();
      if (disposed || !id) return;
      // 第一次拿到的那个是基线：它代表「我这个页面是哪一版」。
      if (baseline === null) { baseline = id; return; }
      if (id !== baseline) setStale(true);
    };

    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [stale]);
  return stale;
}
