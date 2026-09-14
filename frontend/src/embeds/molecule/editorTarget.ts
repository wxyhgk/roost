/**
 * 分子编辑器「在编哪个文件」。
 *
 * 这份状态**必须活得比文件面板久**，原因不是偏好记忆，而是编辑器本身的代价：
 * 它活在一个 iframe 里，iframe 一销毁，整个 JS realm 跟着没——9 MB 代码的顶层执行
 * 结果、React 内部状态、wasm 实例、indigo 的 worker，全是 realm 作用域的。HTTP 缓存
 * 留得住字节，留不住一个跑起来的 realm，所以重开就是一次完整冷启动。
 *
 * 而文件面板在两处会被整棵重建，谁都不够稳：
 *   - `Shell` 里 RightPanel 外面套着 `key={rightView}`：切去服务器状态再切回来就是新的
 *   - `FilesView` 里 `<SessionFiles key={session.id}>`：换个终端就是新的
 *
 * 所以编辑器挂在 `Shell` 上（`App` 只渲染它一次），由这个模块告诉它该编辑什么。
 * 面板负责「选中了哪个文件」，这里负责「编辑器归谁」，两件事分开。
 */
export type MoleculeTarget = {
  sessionId: string;
  /** 打开那一刻的根目录快照。终端之后 cd 走了也不该换掉正在编辑的文件。 */
  root: string;
  path: string;
};

export type MoleculeState = {
  /** 正在编辑的目标；null 表示编辑器关着（但 iframe 还活着）。 */
  open: MoleculeTarget | null;
  /** 关掉之后仍然记得——iframe 没被销毁，它得继续有个归属。 */
  last: MoleculeTarget | null;
  /** 编辑器里有未保存的修改。只有 `open` 非空时才有意义。 */
  dirty: boolean;
  /** 每次保存成功 +1，让对应的文件树去刷新一次。 */
  saved: number;
};

const same = (a: MoleculeTarget | null, b: MoleculeTarget | null) =>
  a === b || (!!a && !!b && a.sessionId === b.sessionId && a.root === b.root && a.path === b.path);

let state: MoleculeState = { open: null, last: null, dirty: false, saved: 0 };
const listeners = new Set<() => void>();

// 快照必须是同一个对象引用，直到真的变了为止：useSyncExternalStore 每次渲染都会比
// getSnapshot 的结果，每次都新建对象会把自己转进无限循环。
function commit(patch: Partial<MoleculeState>) {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}

export function subscribeMolecule(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function getMolecule(): MoleculeState {
  return state;
}

export function openMolecule(target: MoleculeTarget) {
  if (same(state.open, target)) return;
  commit({ open: target, last: target, dirty: false });
}
export function closeMolecule() {
  if (!state.open) return;
  commit({ open: null, dirty: false });
}
export function setMoleculeDirty(dirty: boolean) {
  if (state.dirty !== dirty) commit({ dirty });
}
export function noteMoleculeSaved() {
  commit({ saved: state.saved + 1 });
}

/** 只给测试用：模块级状态会在用例之间串味。 */
export function resetMolecule() {
  state = { open: null, last: null, dirty: false, saved: 0 };
  listeners.clear();
}
