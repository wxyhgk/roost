import { useCallback, useEffect, useRef, useState } from "react";

/*
  屏幕上同时开着的那几个预览窗。

  原来只可能有一个：`selected` 是什么，弹窗就是什么，关掉就是把 `selected` 清空。
  「钉住」当时只是让那一个不吃 Esc、不画遮罩——终端能用了，但想同时看两个文件依然
  做不到，因为打开第二个就把第一个顶掉了。

  现在的规则只有一条：**钉住的窗口脱离「当前选中」这根绳子**，于是那个位置空出来，
  下一个文件就开在它旁边。除此之外没有别的概念——没有平铺、没有最小化、不记布局。
  这几样都要先猜人想怎么排，而现在没有依据可猜。

  另一件顺带解决的事：钉住不再重建窗口。钉住只是把这个 pane 的 `pinned` 翻个面，
  React 那边 `key` 没变、组件实例没变，CodeMirror 里没存的改动就还在。要是做成
  「关掉临时的那个、另开一个钉住的」，那一下就是静默丢草稿。
*/

export type Pane = {
  path: string;
  /** 打开那一刻的根目录快照。终端之后 `cd` 走了，这个窗口也还该读当初那个文件。 */
  root: string;
  pinned: boolean;
  /** 级联用的格子号，创建时定下就不再变——否则点一下置顶，窗口会自己跳一下。 */
  slot: number;
};

/** 级联的格子数。再多就叠回第一格，总比一路铺到屏幕外面强。 */
const CASCADE_SLOTS = 6;
/** 每格错开多少像素。够看见下面那个窗口的标题栏，又不至于把它推出视野。 */
const CASCADE_STEP = 26;

/** 面板默认是居中的，这里给的是相对居中的偏移量。第 0 格就是正中。 */
export function cascadeOffset(slot: number) {
  return { x: slot * CASCADE_STEP, y: slot * CASCADE_STEP };
}

/** 最小的空格子。只开一个窗口时永远是 0，也就是老样子：正中。 */
export function freeSlot(panes: Pane[]) {
  const used = new Set(panes.map((p) => p.slot));
  for (let i = 0; i < CASCADE_SLOTS; i++) if (!used.has(i)) return i;
  return panes.length % CASCADE_SLOTS;
}

/**
 * 把「当前选中的文件」摊进窗口列表。
 *
 * 没钉住的那个窗口是 `selected` 的影子：选中一变它就让位。钉住的一概留着。
 * 数组顺序就是层叠顺序，**末尾在最上面**。
 */
export function syncPanes(prev: Pane[], selected: string | null, root: string): Pane[] {
  const kept = prev.filter((p) => p.pinned);
  if (!selected) return kept;
  // 已经开着（多半是钉住的那个又被点了一下）：置顶，但不碰它的实例、root 和钉住状态。
  const existing = prev.find((p) => p.path === selected);
  if (existing) return [...kept.filter((p) => p.path !== selected), existing];
  return [...kept, { path: selected, root, pinned: false, slot: freeSlot(kept) }];
}

/** 置顶：挪到数组末尾。已经在末尾就原样返回，省一次重渲染。 */
export function raisePane(prev: Pane[], path: string): Pane[] {
  const i = prev.findIndex((p) => p.path === path);
  if (i < 0 || i === prev.length - 1) return prev;
  return [...prev.slice(0, i), ...prev.slice(i + 1), prev[i]];
}

/** 改名了，窗口跟着挪——包括被改名目录底下的那些。 */
export function renamePanes(prev: Pane[], oldPath: string, newPath: string): Pane[] {
  return prev.map((p) =>
    p.path === oldPath ? { ...p, path: newPath }
    : p.path.startsWith(`${oldPath}/`) ? { ...p, path: newPath + p.path.slice(oldPath.length) }
    : p,
  );
}

/**
 * 文件（或目录）没了，开着它的窗口得关掉。
 *
 * 留着的话屏幕上就是一份已经不存在的内容，而那个窗口还能存——一按保存就把删掉的
 * 文件又写回去了。
 */
export function dropPanes(prev: Pane[], path: string, isDir: boolean): Pane[] {
  return prev.filter((p) => p.path !== path && !(isDir && p.path.startsWith(`${path}/`)));
}

export function usePreviewPanes({ selected, root, skip, open, close }: {
  selected: string | null;
  root: string;
  /** 这个文件归弹窗之外的编辑器管，不该有预览窗。 */
  skip: boolean;
  /** `useFileViewer` 的 open：会带上「未保存」的确认，取消时返回 false。 */
  open: (path: string) => boolean;
  close: () => void;
}) {
  const [panes, setPanes] = useState<Pane[]>([]);

  const latest = useRef({ panes, selected });
  latest.current = { panes, selected };

  useEffect(() => {
    setPanes((prev) => syncPanes(prev, skip ? null : selected, root));
  }, [selected, root, skip]);

  const togglePin = useCallback((path: string) => {
    const pane = latest.current.panes.find((p) => p.path === path);
    if (!pane) return;
    if (!pane.pinned) {
      // 钉住＝松开「当前选中」这根绳子，那个位置就空出来给下一个文件。
      setPanes((prev) => prev.map((p) => (p.path === path ? { ...p, pinned: true } : p)));
      close();
      return;
    }
    /*
      取消钉住＝把它交回「当前这个」的位置上，而不是关掉它。所以要走一遍 `open`：
      原来占着那个位置的窗口可能有没保存的改动，那句确认得问。被拦下来就什么都不做。
    */
    if (path !== latest.current.selected && !open(path)) return;
    setPanes((prev) =>
      prev.filter((p) => p.pinned || p.path === path).map((p) => (p.path === path ? { ...p, pinned: false } : p)),
    );
  }, [open, close]);

  const closePane = useCallback((path: string) => {
    setPanes((prev) => prev.filter((p) => p.path !== path));
    // 关的正是「当前选中」那个：选中也得跟着清，否则树上还高亮着、焦点也不还给终端。
    if (path === latest.current.selected) close();
  }, [close]);

  const raise = useCallback((path: string) => setPanes((prev) => raisePane(prev, path)), []);
  const rename = useCallback((oldPath: string, newPath: string) => setPanes((prev) => renamePanes(prev, oldPath, newPath)), []);
  const drop = useCallback((path: string, isDir: boolean) => setPanes((prev) => dropPanes(prev, path, isDir)), []);

  return { panes, togglePin, closePane, raise, rename, drop };
}
