import { useEffect, useRef, useSyncExternalStore } from "react";
import { closeMolecule, getMolecule, openMolecule, subscribeMolecule } from "../../molecule/editorTarget";

/** 走分子编辑器而不是文本预览的扩展名。 */
export const MOLECULE_FILE = /\.(mol|sdf)$/i;

/**
 * 关掉编辑器。
 *
 * 原样转发 store 的那个函数，只是**换个门进**：这座桥存在的全部意义就是让「分子
 * 那边的协议变了要改几处」的答案是 1。原来 `Tree` 绕过桥自己 import store 去关，
 * 答案就成了 2——而那两处还分别只知道一半的事。
 *
 * 做成模块级导出而不是 hook 的返回值，是因为调用方通常要在**调用这个 hook 之前**
 * 就把「怎么关」准备好（`onClosedItself` 要用它），拿返回值就晚了。
 */
export { closeMolecule as closeMoleculeEditor };

/**
 * 文件面板和分子编辑器之间的那座桥。
 *
 * 从 `features/files/` 搬到这里：文件树不该认识「分子」这件具体的事，它只该问注册表
 * 「这个文件归谁管」。见同目录的 index.ts 和 shared/editor 里的 ExternalEditor。
 *
 * 编辑器**不由文件面板渲染**——它挂在 `Shell` 上，因为这棵树自己会被整棵重建
 * （右面板换视图、换终端各有一个 key），而编辑器的 iframe 一销毁，那 9 MB 代码的
 * 顶层执行、wasm 实例、indigo worker 就全没了，重开就是一次冷启动。
 *
 * 所以两边只交换三件事，这个 hook 就是那三件：
 *   - 选中分子文件时告诉编辑器该编谁
 *   - 编辑器自己被关掉时（关闭按钮、Esc）把选中一并撤掉
 *   - 编辑器保存成功后让文件树刷新一次
 *
 * 单独成一个 hook，是因为这三件事和「画一棵目录树」没有任何关系——它们挤在 Tree 里
 * 只是因为 `selected` 住在那儿。
 */
export function useMoleculeBridge({ sessionId, selected, root, isMolecule, onClosedItself, onSaved }: {
  sessionId: string;
  selected: string | null;
  /** 打开那一刻的根目录快照，和预览用的是同一个。 */
  root: string;
  /*
    由调用方算好传进来，不在这里算。

    它只是对路径做一次 MOLECULE_FILE 正则，和编辑器状态无关；而调用方**必须**先有
    这个答案才能决定文本预览要不要让路，也就是说它一定在建这座桥之前就已经算出来
    了。让桥再算一遍并返回，会逼着调用方等桥建完才知道答案，凭空造出一个依赖环。
  */
  isMolecule: boolean;
  onClosedItself(): void;
  onSaved(): void;
}) {
  const molecule = useSyncExternalStore(subscribeMolecule, getMolecule);
  /*
    编辑器可能正编着**别的会话**的文件——打开着切终端不该把它关掉。
    那种时候它的 dirty 和保存都与这棵树无关。
  */
  const mine = molecule.open?.sessionId === sessionId;

  useEffect(() => {
    if (isMolecule && selected) openMolecule({ sessionId, root, path: selected });
  }, [isMolecule, selected, root, sessionId]);

  /*
    编辑器被它自己关掉了：把选中一并撤掉——否则树上还高亮着一个没人在编辑的文件，
    再点一次也没反应（`selected` 没变，effect 不会重跑）。

    这里**读 store 的当前值而不是本次渲染的快照**：上面那个「打开」的 effect 就在
    同一次提交里刚写过 store，而快照还停在写之前。照快照判断的话，刚选中的文件会
    被当成「已经关了」立刻关掉。
  */
  useEffect(() => {
    if (!isMolecule) return;
    const open = getMolecule().open;
    if (!open || open.sessionId !== sessionId || open.path !== selected) onClosedItself();
  }, [molecule.open, isMolecule, selected, sessionId, onClosedItself]);

  // 保存成功后刷新文件树。第一次渲染不该当成一次保存，所以记住基线。
  const seenSaves = useRef(molecule.saved);
  useEffect(() => {
    if (molecule.saved === seenSaves.current) return;
    seenSaves.current = molecule.saved;
    if (mine) onSaved();
  }, [molecule.saved, mine, onSaved]);

  /** 编辑器里有未保存的修改，**且编的是这个会话的文件**。 */
  return { dirty: mine && molecule.dirty };
}
