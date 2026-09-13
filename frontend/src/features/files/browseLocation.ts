/**
 * 文件面板「上次看到哪儿」的记忆。
 *
 * 这份状态**必须活得比组件久**：面板收起再展开、切走另一个会话再切回来，都应该
 * 回到原处，而这些操作都会把组件卸载掉。所以它是模块级的，不是 state。
 *
 * 原来它是 `FilesView.tsx` 里一个裸的 `Map`——一千多行文件中间的一个隐形全局变量，
 * 既没法测，也看不出谁在写它。
 */
export type BrowseLocation = {
  mode: "tree" | "list";
  path: string;
  /** 正在看的那个文件。**只记不渲染**：它不影响面板的渲染，进 state 只会白白多一次重渲染。 */
  file?: string | null;
};

/**
 * 记忆的键。
 *
 * **必须同时含会话和根目录**：不同会话各看各的；同一个会话换了根目录，之前那个
 * 子路径就不存在了，不该带过去。
 */
export function locationKey(sessionId: string, root: string): string {
  return JSON.stringify([sessionId, root]);
}

const locations = new Map<string, BrowseLocation>();

export function readLocation(key: string): BrowseLocation | null {
  return locations.get(key) ?? null;
}

export function writeLocation(key: string, location: BrowseLocation): void {
  locations.set(key, location);
}

/** 只给测试用：模块级状态会在用例之间串味。 */
export function resetLocations(): void {
  locations.clear();
}
