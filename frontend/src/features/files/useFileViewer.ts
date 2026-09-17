import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenFile } from "./useOpenFile";
import { useExternalOpen } from "./useExternalOpen";
import { EXTERNAL_EDITORS } from "../../plugins/external";
import { closeExternalEditors, handledExternally, useExternalEditor } from "../../shared/editor";

/**
 * 「正在看的那个文件」的全部状态。
 *
 * 这一摊原来长在 `Tree` 里，和「目录里有哪些条目」缝在一个组件上。两边其实只在
 * 两个点相接——列表要知道该高亮哪一行（`selected`），点一行要能打开（`open`）——
 * 除此之外目录列表那半边一次都不碰这里的东西。
 *
 * 分开之后的直接好处是那个前向引用的 ref 没了，见下面「顺序」一段。
 */
export function useFileViewer({ cwd, sessionId, initialFile, onFileChange, onSaved }: {
  cwd: string;
  sessionId: string;
  initialFile: string | null;
  /** 选中变了。地址栏要记住它，好让下次回到这个会话时还打开着。 */
  onFileChange(path: string | null): void;
  /** 分子编辑器保存成功了——文件变了，树该刷新。 */
  onSaved(): void;
}) {
  const [previewDirty, setPreviewDirty] = useState(false);

  /*
    「有未保存的修改吗」有两个来源：文本预览自己的 `previewDirty`，和分子编辑器
    报上来的那份。**各记各的，用的时候再合**——让两边写同一个标记会互相擦除：
    文本文件改到一半时分子那边一变化就会把它清成干净，而分子编辑器关掉之后它的 true
    又会赖在那儿，害得下次切文件平白弹一次确认。

    用 ref 读而不是把值传进 useOpenFile：那个判断只在「真的要换文件」那一刻需要，
    提前捕获会拿到过期的答案。
  */
  const unsavedRef = useRef(false);

  const { selected, root, open, close: closeSelection, rename } = useOpenFile({
    cwd,
    sessionId,
    initialFile,
    hasUnsavedChanges: useCallback(() => unsavedRef.current, []),
    onOpened: useCallback(() => setPreviewDirty(false), []),
  });

  const { linkError, dismissLinkError, linkRequest, consumeLinkLine } =
    useExternalOpen({ cwd, sessionId, open });

  // 打开、关闭、改名、删除都会改 selected，所以在这里统一记一次，
  // 而不是在每个改它的地方各写一遍、然后漏掉其中一个。
  useEffect(() => { onFileChange(selected); }, [selected, onFileChange]);

  /*
    顺序。

    「归不归外部编辑器管」只是拿注册表对路径做一次匹配，和那些编辑器的状态无关——所以
    在这里先算出来，不问它们。这一下把依赖捋直了：匹配 → `close` → 通知外部编辑器。

    原来是反过来的：那个答案从桥的返回值拿，于是桥必须先建，而桥又要 `close` 做参数，
    `close` 又要等预览——一个真实的环，当时是拿一层 `useRef<() => void>` 把调用推迟过去
    绕开的。同理 `closeExternalEditors` 是模块级函数而不是 hook 的返回值。

    文件内容也不在这里读了：屏幕上可以同时开着好几个预览窗，每个盯着各自的路径，
    内容归各自的窗口读（见 `FilePreviewModal`）。这里只剩「树上高亮哪一行」。
  */
  const external = handledExternally(EXTERNAL_EDITORS, selected);

  const close = useCallback(() => {
    closeSelection();
    // 行号跟着这次打开作废：否则之后用点击重新打开同一个文件，会莫名其妙跳到上次
    // 从终端链接进来时的那一行。
    consumeLinkLine();
    closeExternalEditors(EXTERNAL_EDITORS);
  }, [closeSelection, consumeLinkLine]);

  const { dirty: externalDirty } = useExternalEditor(EXTERNAL_EDITORS, {
    sessionId,
    root,
    path: selected,
    onClosedItself: close,
    onSaved,
  });
  unsavedRef.current = previewDirty || externalDirty;

  return {
    /** 树上该高亮哪一行。 */
    selected,
    /** 打开一个文件。点行、终端链接、命令面板、新建后自动选中，四条路都汇到这里。 */
    open,
    /** 关掉当前打开的东西（文本预览，或弹窗之外的编辑器）。 */
    close,
    /** 改名了，把选中跟着挪。 */
    rename,
    /** 这个文件归弹窗之外的编辑器管，`Tree` 就不该再渲染文本预览。 */
    handledExternally: external,
    /** 终端链接指到根目录外面了。给人看的提示，不是异常。 */
    linkError,
    dismissLinkError,
    /** 这次打开带着行号（从终端链接进来的），预览跳过去之后要 consume 掉。 */
    linkRequest,
    consumeLinkLine,
    /** 打开那一刻的根目录快照——终端之后 cd 走了不该换掉正在看的文件。 */
    root,
    /** 文本预览报上来的脏标记；分子那边的脏由桥自己收。 */
    notePreviewDirty: setPreviewDirty,
  };
}
