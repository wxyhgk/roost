import { downloadFileUrl, readFilePreview, type FileNode } from "../../shared/api";
import { downloadFile } from "../../shared/download";
import { quoteShellPath, sendToSession } from "../terminal/public";
import { t } from "@roost/i18n";
import { writeClipboard } from "../../shared/clipboard";
import type { FolderActions, NewKind } from "./types";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

/**
 * 树上某一行的右键菜单：**「右键这一行能干什么」这份清单**。
 *
 * 从 `TreeNode.tsx` 拆出来，理由和当初把 `TreeNode` 从 `Tree.tsx` 拆出来的一样：
 * 两个组件的变化原因不同。这份清单变，是因为要加一个动作（复制内容、下载、在此新建
 * 都是这么加进来的）；`TreeNode` 变，是因为树的呈现或取数变。合在一个文件里的时候，
 * 改菜单要在四百多行里找位置，而两边谁都读不懂对方那一半。
 */
export function NodeMenu({
  x,
  y,
  cwd,
  node,
  sessionId,
  folder,
  onNavigate,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  cwd: string;
  node: FileNode;
  sessionId: string;
  folder: FolderActions;
  /** 列表模式下才有。有它就说明这棵树是平的，没有子列表可以就地长出新建行。 */
  onNavigate?: (path: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const isDir = node.kind === "dir";

  /*
    「在这个文件夹里新建」。

    **列表模式下不能只设 pending 就完事**——那是这个菜单三个新建项以前什么都不做的原因：
    新建行只有两个落脚点，顶层那个要求 `pending.dir === 当前浏览目录`（右键的是子目录，
    不匹配），节点里那个在列表模式下被 `!onNavigate` 整段关掉了（平列表没有子列表）。
    于是 pending 设上了，却没有任何地方渲染得出来，看起来就是「点了没反应」。

    所以列表模式先进到那个目录里去：directory 变成它，新建行就落在顶层，和「在当前目录
    新建」完全是同一条路。树模式下 onNavigate 是 undefined，照旧就地展开。
  */
  const createIn = (kind: NewKind) => {
    onClose();
    onNavigate?.(node.path);
    /*
      **等菜单把焦点还完再挂输入框。**

      菜单用的是 floating-ui 的 `FloatingFocusManager`，它带 `returnFocus`——关闭时把
      焦点还给触发它的那一行。而那次归还是在 `queueMicrotask` 里做的（见
      `@floating-ui/react` 里 `getFirstTabbableElement(returnElement)` 那段），**晚于**
      React 这一轮提交，也就晚于新建行 `autoFocus` 拿到焦点。

      于是：输入框刚拿到焦点 → 菜单把焦点抢回那一行 → 输入框失焦 → `InlineRename` 的
      onBlur 判定为「编辑结束」→ `NewEntryRow` 当成取消 → 行当场消失。用户看到的就是
      「点了没反应」。（而且因为名字是空串，那次 blur 连提交都不会做：
      `draft.trim() || value` 等于 value，`next !== value` 不成立。）

      `setTimeout(0)` 是宏任务，跨过整批微任务，所以归还先发生、输入框后拿焦点。
      不用 `queueMicrotask`：我们的微任务排在点击处理器里，**早于**它那一个，没用。
    */
    setTimeout(() => folder.create(node.path, kind), 0);
  };

  async function copy(text: string) {
    onClose();
    if (!(await writeClipboard(text))) window.alert(t.files.menu.copyFailed);
  }

  async function copyContent() {
    onClose();
    let file;
    try {
      file = await readFilePreview(cwd, node.path);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.files.menu.readFailed);
      return;
    }
    // 二进制读回来的 content 是空串。照抄会**静悄悄地清空剪贴板**，
    // 看起来和复制成功一模一样。
    if (file.binary) {
      window.alert(t.files.menu.copyBinary);
      return;
    }
    if (!(await writeClipboard(file.content))) {
      window.alert(t.files.menu.copyFailed);
      return;
    }
    // 后端在 8 MiB 处截断。复制成功但内容不全，这件事必须说出来。
    if (file.truncated) window.alert(t.files.menu.copyTruncated);
  }

  function insertToTerminal() {
    onClose();
    if (sendToSession(sessionId, `${quoteShellPath(node.path)} `) === "rejected") {
      window.alert(t.files.menu.insertFailed);
    }
  }

  /*
    下载走一个临时 <a download>，而不是 location.href。

    直接改 location 会让整个 SPA 走一遍导航——即使浏览器最终认出这是 attachment
    转而下载，中间那一下也可能把终端的 WebSocket 连接掐了。
  */
  function download() {
    onClose();
    // 这一路下的是服务端地址（`/api/file/raw`），不是 Blob——没有 object URL 要回收。
    downloadFile(downloadFileUrl(cwd, node.path), node.name);
  }

  return (
    <Menu x={x} y={y} onClose={onClose}>
      <MenuItem label={t.files.menu.copyPath} onClick={() => void copy(node.path)} />
      <MenuItem label={t.files.menu.copyAbsolutePath} onClick={() => void copy(`${cwd}/${node.path}`)} />
      {!isDir && <MenuItem label={t.files.menu.copyContent} onClick={() => void copyContent()} />}
      <MenuItem label={t.files.menu.insertToTerminal} onClick={insertToTerminal} />
      <MenuSeparator />
      {isDir ? (
        <MenuItem label={t.files.menu.uploadHere} onClick={() => { onClose(); folder.upload(node.path); }} />
      ) : (
        <MenuItem label={t.files.menu.download} onClick={download} />
      )}
      <MenuSeparator />
      {isDir && (
        <>
          <MenuItem label={t.files.menu.newFile} onClick={() => createIn("file")} />
          <MenuItem label={t.files.menu.newFolder} onClick={() => createIn("dir")} />
          <MenuItem label={t.files.menu.newMolecule} onClick={() => createIn("mol")} />
        </>
      )}
      <MenuItem label={t.files.menu.rename} onClick={() => { onClose(); onRename(); }} />
      <MenuItem label={t.files.menu.remove} danger onClick={() => { onClose(); onDelete(); }} />
    </Menu>
  );
}
