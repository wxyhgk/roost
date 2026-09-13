import { useEffect, useRef, useState } from "react";
import { downloadFileUrl, listDir, readFilePreview, renamePath, deletePath, type FileNode } from "../../shared/api";
import { IconChevron, IconEdit, IconFolder, IconTrash } from "../../shared/icons";
import { InlineRename } from "../../shared/ui/InlineRename";
import { ROOST_PATH_MIME, quoteShellPath, sendToSession } from "../terminal/public";
import { t } from "@roost/i18n";
import { writeClipboard } from "../../shared/clipboard";
import { FileIcon } from "./FileGlyphs";
import { createCoalescedLoad } from "./coalescedLoad";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

/**
 * 树上的一行，以及它的右键菜单。
 *
 * 从 `Tree.tsx` 拆出来：那个文件里原本装着三个组件 628 行，而这两个和「当前打开的是
 * 哪个文件」那套路由逻辑完全无关——它们只关心自己这一行怎么画、展开时取什么。
 */

function MatchedName({ name, query }: { name: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{name}</span>;
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return <span>{name}</span>;
  return (
    <span>
      {name.slice(0, i)}
      <mark className="rounded-sm bg-accent/30 text-inherit">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </span>
  );
}

export function TreeNode({
  cwd,
  onNavigate,
  sessionId,
  node,
  depth,
  selected,
  onSelect,
  query,
  rev,
  onRenamed,
  onDeleted,
  folder,
}: {
  cwd: string;
  onNavigate?: (path: string) => void;
  sessionId: string;
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  query: string;
  rev: number;
  onRenamed: (oldPath: string, newPath: string) => void;
  onDeleted: (path: string, isDir: boolean) => void;
  /** 落在被右键的那个目录上的动作，见 FolderActions。 */
  folder: FolderActions;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isDir = node.kind === "dir";
  const active = selected === node.path;
  const q = query.trim().toLowerCase();
  const filteredOut = !!q && !isDir && !node.name.toLowerCase().includes(q);

  async function toggle() {
    if (!isDir) {
      onSelect(node.path);
      return;
    }
    if (onNavigate) {
      onNavigate(node.path);
      return;
    }
    if (!open && children == null) {
      setLoading(true);
      try {
        setChildren(await listDir(cwd, node.path));
      } catch (err) {
        window.alert(err instanceof Error ? err.message : t.files.node.expandFailed);
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  /*
    增删改之后刷新已展开目录的内容。

    和根目录同一套「在途就排队、不打断」——而且这里更要紧：树上每个展开着的目录都有
    一个这样的 effect，原来的写法下一次文件变化通知会让**每一个**都打断重发。
    展开十个目录、终端里跑着构建，就是每秒几十个互相掐掉的请求，一个都到不了。

    取数器按 (cwd, node.path) 建一次，`rev` 只是戳它一下。
  */
  const refreshChildren = useRef<(() => void) | null>(null);
  useEffect(() => {
    const feed = createCoalescedLoad((signal) => listDir(cwd, node.path, signal), {
      data: setChildren,
      error() { /* 刷新失败时保留旧列表：半棵树也比空白强。 */ },
    });
    refreshChildren.current = feed.load;
    return () => { refreshChildren.current = null; feed.dispose(); };
  }, [cwd, node.path]);

  const seenRev = useRef(rev);
  useEffect(() => {
    if (seenRev.current === rev) return;
    seenRev.current = rev;
    // 没展开、或者还没加载过的目录不用刷——展开时自然会取。
    if (open && children != null) refreshChildren.current?.();
  }, [rev, open, children]);

  // Every hook above must run unconditionally; hiding happens only at render time.
  if (filteredOut) return null;

  async function commitRename(name: string) {
    const clean = name.trim();
    if (!clean || clean === node.name || clean.includes("/")) return;
    const slash = node.path.lastIndexOf("/");
    const newPath = slash < 0 ? clean : `${node.path.slice(0, slash + 1)}${clean}`;
    try {
      await renamePath(cwd, node.path, newPath);
      onRenamed(node.path, newPath);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.files.node.renameFailed);
    }
  }

  async function removeNode() {
    const ok = window.confirm(isDir ? t.files.node.deleteDirConfirm(node.path) : t.files.node.deleteFileConfirm(node.path));
    if (!ok) return;
    try {
      await deletePath(cwd, node.path);
      onDeleted(node.path, isDir);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.files.node.deleteFailed);
    }
  }
  return (
    <li>
      <div
        className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 ${
          active ? "bg-bg-hover" : "hover:bg-bg-hover"
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          if (renaming) return;
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setData(ROOST_PATH_MIME, node.path);
          e.dataTransfer.setData("text/plain", node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {renaming ? (
          <InlineRename
            value={node.name}
            editing
            onCommit={(name) => void commitRename(name)}
            onEditingChange={(editing) => {
              if (!editing) setRenaming(false);
            }}
            className="text-text"
          />
        ) : (
          <>
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-text"
              title={node.name}
              onClick={() => void toggle()}
            >
              {isDir ? (
                <IconChevron open={open} />
              ) : (
                <span className="w-3" />
              )}
              {isDir ? <IconFolder /> : <FileIcon name={node.name} />}
              <span className="min-w-0 truncate"><MatchedName name={node.name} query={query} /></span>
            </button>
            <span
              className={`flex shrink-0 items-center gap-0.5 ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
              }`}
            >
              <button
                className="grid h-5 w-5 place-items-center rounded-md text-text-dim hover:bg-bg-active hover:text-text"
                title={t.files.node.renameTitle(node.name)}
                onClick={() => setRenaming(true)}
              >
                <IconEdit />
              </button>
              <button
                className="grid h-5 w-5 place-items-center rounded-md text-text-dim hover:bg-bg-active hover:text-danger"
                title={isDir ? t.files.node.deleteDirTitle(node.name) : t.files.node.deleteFileTitle(node.name)}
                onClick={() => void removeNode()}
              >
                <IconTrash />
              </button>
            </span>
          </>
        )}
      </div>
      {isDir && open && !onNavigate && (
        <ul>
          {loading && (
            <li className="px-2.5 py-2 text-caption leading-[1.45] text-text-dim">
              {t.files.tree.loading}
            </li>
          )}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              cwd={cwd}
              sessionId={sessionId}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              query={query}
              rev={rev}
              onRenamed={onRenamed}
              onDeleted={onDeleted}
              folder={folder}
            />
          ))}
        </ul>
      )}
      {menu && (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          cwd={cwd}
          node={node}
          sessionId={sessionId}
          folder={folder}
          onRename={() => setRenaming(true)}
          onDelete={() => void removeNode()}
          onClose={() => setMenu(null)}
        />
      )}
    </li>
  );
}

/**
 * 右键菜单里那些**需要面板层配合**的动作。
 *
 * 「上传到这里」和「新建」落在被右键的那个目录上，而上传队列和新建行都住在
 * `FilesView`——树只负责把用户点的是哪个目录报上去。走一个对象而不是两个 prop，
 * 是因为 `TreeNode` 是递归的：每多一个 prop 就要在递归那一处多抄一行。
 */
export type FolderActions = {
  /** 把上传目标定到 `dir`，然后打开文件选择器。 */
  upload(dir: string): void;
  /** 把新建行的目标切到 `dir` 并打开它。 */
  create(dir: string, kind: "file" | "dir"): void;
};

function NodeMenu({
  x,
  y,
  cwd,
  node,
  sessionId,
  folder,
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
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const isDir = node.kind === "dir";

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
    const a = document.createElement("a");
    a.href = downloadFileUrl(cwd, node.path);
    a.download = node.name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
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
          <MenuItem label={t.files.menu.newFile} onClick={() => { onClose(); folder.create(node.path, "file"); }} />
          <MenuItem label={t.files.menu.newFolder} onClick={() => { onClose(); folder.create(node.path, "dir"); }} />
        </>
      )}
      <MenuItem label={t.files.menu.rename} onClick={() => { onClose(); onRename(); }} />
      <MenuItem label={t.files.menu.remove} danger onClick={() => { onClose(); onDelete(); }} />
    </Menu>
  );
}
