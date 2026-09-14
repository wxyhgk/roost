import { Suspense, createElement, lazy, useSyncExternalStore } from "react";
import type { ExternalEditor, ExternalEditorContext } from "../../shared/editor";
/*
  弹窗本体懒加载。Host 在 `!molecule.last` 时就已经 return null 了——也就是说在你第一次
  打开一个分子文件之前，这段代码一行都用不上，没理由压在首屏里。

  注意它和 iframe 的冷启动是两回事：真正贵的那 9 MB 代码加 wasm 住在 iframe 里，由
  molecule.html 那个独立入口加载，从来就不在首屏。这里摘掉的只是外面那层壳。
*/
const MoleculeModal = lazy(() => import("../../embeds/molecule/MoleculeModal").then(m => ({ default: m.MoleculeModal })));
import { closeMolecule, getMolecule, noteMoleculeSaved, setMoleculeDirty, subscribeMolecule } from "../../embeds/molecule/editorTarget";
import { isMoleculeFile, useMoleculeBridge } from "./bridge";
import { t } from "@roost/i18n";

/**
 * 分子编辑器，作为一个**活在预览弹窗之外**的编辑器接进插件注册表。
 *
 * 它不能做成普通的 `preview` 插件：那是渲染在 `FilePreviewModal` 里的，而那个弹窗
 * `key={selected}`，每换一个文件就重挂一次。这个编辑器住在 iframe 里，销毁一次就是
 * 9 MB 代码加 wasm 的完整冷启动（理由写在 embeds/molecule/editorTarget.ts 顶部）。
 *
 * 所以它走 `ExternalEditor` 这条路：`Host` 由 Shell 渲染一次、活在整棵树唯一稳定的
 * 落点上，`use` 让文件树隔空告诉它该编辑谁。这样 Shell 和 features/files 都不必再
 * import 任何分子相关的东西——在此之前两边都直接 import 了 embeds/molecule/，于是「有哪些
 * 类型走弹窗外的编辑器」这个问题散在三处。
 */
function Host() {
  const molecule = useSyncExternalStore(subscribeMolecule, getMolecule);
  // last 而不是 open：关掉之后 iframe 仍然活着，它得继续有个归属。
  if (!molecule.last) return null;
  // fallback 用 null：弹窗加载的那一瞬间不该先闪一个占位框。
  return createElement(Suspense, { fallback: null }, createElement(MoleculeModal, {
    open: !!molecule.open,
    sessionId: molecule.last.sessionId,
    root: molecule.last.root,
    path: molecule.last.path,
    onClose: closeMolecule,
    onDirtyChange: setMoleculeDirty,
    onSaved: noteMoleculeSaved,
  }));
}

export const moleculeEditor: ExternalEditor = {
  match: isMoleculeFile,
  get region() { return t.misc.shell.regionMolecule; },
  Host,
  use(context: ExternalEditorContext) {
    return useMoleculeBridge({
      sessionId: context.sessionId,
      selected: context.path,
      root: context.root,
      isMolecule: context.active,
      onClosedItself: context.onClosedItself,
      onSaved: context.onSaved,
    });
  },
  // 关一个没开着的编辑器是无害的：store 里 open 置空，iframe 照旧活着。
  close: closeMolecule,
};
