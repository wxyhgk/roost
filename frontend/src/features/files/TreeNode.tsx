import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { listDir, renamePath, deletePath, type FileNode } from "../../shared/api";
import { IconChevron, IconEdit, IconFolder, IconTrash } from "../../shared/icons";
import { InlineRename } from "../../shared/ui/InlineRename";
import { ROOST_PATH_MIME } from "../terminal/public";
import { t } from "@roost/i18n";
import { FileIcon } from "./FileGlyphs";
import { NewEntryRow } from "./NewEntryRow";
import { NodeMenu } from "./NodeMenu";
import type { FolderActions, PendingCreate } from "./types";
import { renameTarget } from "./rename";
import { createCoalescedLoad } from "./coalescedLoad";

/**
 * 树上的一行：它怎么画、展开时取什么、改名删除拖放。
 *
 * 从 `Tree.tsx` 拆出来：那个文件里原本装着三个组件 628 行，而这一个和「当前打开的是
 * 哪个文件」那套路由逻辑完全无关——它只关心自己这一行怎么画、展开时取什么。
 *
 * 右键菜单（「右键这一行能干什么」那份清单）在 `NodeMenu.tsx`，同一条理由再用一次。
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
  pending,
  onDropFiles,
  dropTargetDir,
  onDropTargetChange,
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
  pending: PendingCreate | null;
  /**
   * 从系统里拖文件进来，落在**这个目录**上。
   *
   * 只有目录接；拖在文件行上不拦，让事件冒泡到面板那层，落到当前浏览目录——
   * 「拖到一个文件上」本来就没有明确含义，猜一个不如让它走默认。
   */
  onDropFiles?: (event: ReactDragEvent, directory: string) => void;
  /** 面板那边记着的唯一目标。等于自己的路径就点亮。 */
  dropTargetDir?: string | null;
  /** 光标进到这一行时报给面板。**离开不报**——移到别处时那边自己会被覆盖或清掉。 */
  onDropTargetChange?: (directory: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  /** 取子项失败。**只在一个条目都没有时才显示**，刷新失败保留旧列表。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const isDir = node.kind === "dir";
  /*
    这一行是不是拖放目标，**由父级那一份 `dropTargetDir` 推出来，不自己存**。

    自己存过一版，用 dragenter/dragleave 维护，结果是鼠标扫过的每个目录都留着高亮：
    `dragleave` 在光标移到**子元素**上时也会触发，那时 `e.target` 是子元素而不是这一行，
    于是「离开了吗」永远判假、永远不熄。真正离开这一行时同样判假。

    改成推导之后，「最多只有一个目录被点亮」是结构性的——不靠 enter/leave 配平来维持。
  */
  const dropTarget = isDir && dropTargetDir != null && dropTargetDir === node.path;
  const active = selected === node.path;
  const q = query.trim().toLowerCase();
  const filteredOut = !!q && !isDir && !node.name.toLowerCase().includes(q);

  /*
    取子项的**唯一一条路**。

    原来有三条：pending 自动展开一条裸 `listDir`、`toggle()` 一条裸 `listDir`、刷新这一条
    走排队取数器。前两条不传 signal、也没有 cancelled 守卫，而三条都 `setChildren`，
    于是终端里跑着构建（文件监听在推 `rev`）时点开一个目录，两个响应无序到达，**慢的那个
    用旧内容盖掉新内容**；更糟的是当时 `rev` 已经被下面那个 effect 消费掉了，于是要等下一次
    文件变化才会纠正，中间一直显示着过期的列表。

    取数器按 (cwd, node.path) 建一次，`rev` 和展开只是戳它一下。它在途时再戳只记一笔、
    不打断，所以「展开」和「刷新」撞在一起的结果是**后发的那次一定最后写**，没有谁盖谁。
  */
  // 回调闭在建取数器那一轮渲染上，读 children 得走一份渲染期同步的 ref（同 usePreviewPanes）。
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const loadChildren = useRef<(() => void) | null>(null);
  useEffect(() => {
    const feed = createCoalescedLoad((signal) => listDir(cwd, node.path, signal), {
      start() { setLoading(true); },
      data(list) { setChildren(list); setLoadError(null); },
      error(reason) {
        /*
          **展开失败要说出来。** 原来这里是个空 catch，于是「取不到」和「空目录」在界面上
          长得一模一样——一个展不开的目录看起来就是个空目录，连重试的理由都没有。

          反过来，刷新失败时保留旧列表：半棵树也比空白强，所以有内容时不覆盖成错误。
        */
        if (childrenRef.current == null) {
          setLoadError(reason instanceof Error ? reason.message : t.files.node.expandFailed);
        }
      },
      settled() { setLoading(false); },
    });
    loadChildren.current = feed.load;
    return () => {
      loadChildren.current = null;
      feed.dispose();
      // dispose 之后 settled 不会再来，`loading` 得自己落下去，否则占位一直挂着。
      setLoading(false);
    };
  }, [cwd, node.path]);

  /*
    新建落到这个目录上时，它得自己展开——新条目那一行就长在 children 里，目录收着就
    看不见。做成声明式的而不是在右键菜单里手动 setOpen：目标从哪儿设过来都一样生效
    （右键条目、右键空白、工具栏 +），不用每加一个入口就补一次。

    只在 pending.dir 变成自己时跑一次；之后用户手动收起来是他的自由，不硬按着。
    **这里只负责展开，不取数**：取数由下面那个 effect 按「展开了没有内容」推出来。
  */
  useEffect(() => {
    if (pending?.dir !== node.path || !isDir || onNavigate) return;
    setOpen(true);
  }, [pending?.dir, node.path, isDir, onNavigate]);

  /*
    什么时候该取一次：展开着，而且**要么还没有内容，要么内容比 `rev` 旧**。

    写成推导而不是在 `toggle()` 里发请求，是为了让「首次展开」和「文件变化后刷新」共用
    同一个判据。`seenRev` 只在真的取了之后才推进——原来是先推 `seenRev` 再判断要不要刷，
    于是目录收着（或首次取数还在途）时来的那一拍被吞掉，展开后拿到的是那一拍之前的内容。
  */
  const seenRev = useRef(rev);
  useEffect(() => {
    if (!open) return;
    if (children != null && seenRev.current === rev) return;
    seenRev.current = rev;
    loadChildren.current?.();
  }, [open, rev, children]);

  // Every hook above must run unconditionally; hiding happens only at render time.
  if (filteredOut) return null;

  function toggle() {
    if (!isDir) {
      onSelect(node.path);
      return;
    }
    if (onNavigate) {
      onNavigate(node.path);
      return;
    }
    /*
      **只翻开，取数交给上面那个 effect。** 原来是 `await listDir(...)` 之后才 setOpen，
      于是慢链路上点下去要等一整个往返才有反应，而且那次取数在 `open` 还是 false 的时候
      发生——期间来的 `rev` 因此被判成「没展开，不用刷」丢掉。
    */
    setOpen((v) => !v);
  }

  async function commitRename(name: string) {
    const newPath = renameTarget(node.path, name);
    // null＝这不构成一次改名（空、同名、含 `/`），当作没按过，见 rename.ts。
    if (!newPath) return;
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
          dropTarget ? "outline outline-2 outline-accent bg-bg-hover" : active ? "bg-bg-hover" : "hover:bg-bg-hover"
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          if (renaming) return;
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setData(ROOST_PATH_MIME, node.path);
          e.dataTransfer.setData("text/plain", node.path);
        }}
        /*
          只有目录接系统拖进来的文件，而且必须 `stopPropagation`——不拦住的话面板那层
          也会处理同一次 drop，同一批文件会被传两遍（一遍进这个目录、一遍进当前目录）。

          判 `types.includes("Files")` 是因为树上的节点自己也可拖（拖去终端），
          不判的话拖动节点经过别的目录会被当成上传。
        */
        onDragOver={(e) => {
          if (!isDir || !onDropFiles || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          onDropTargetChange?.(node.path);
        }}
        onDrop={(e) => {
          if (!isDir || !onDropFiles || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          onDropTargetChange?.(null);
          onDropFiles(e, node.path);
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
              onClick={toggle}
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
          {/* 「加载中」只在没内容时占位：刷新一个已经展开的目录不该把它的内容换成一行字。 */}
          {loading && children == null && (
            <li className="px-2.5 py-2 text-caption leading-[1.45] text-text-dim">
              {t.files.tree.loading}
            </li>
          )}
          {loadError && !loading && (
            <li role="alert" className="px-2.5 py-2 text-caption leading-[1.45] text-danger">
              {loadError}
            </li>
          )}
          {pending?.dir === node.path && (
            <NewEntryRow depth={depth + 1} kind={pending.kind} error={pending.error}
              onCommit={pending.commit} onCancel={pending.cancel} />
          )}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              cwd={cwd}
              sessionId={sessionId}
              node={c}
              depth={depth + 1}
              pending={pending}
              onDropFiles={onDropFiles}
              dropTargetDir={dropTargetDir}
              onDropTargetChange={onDropTargetChange}
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
          onNavigate={onNavigate}
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
 *
 * 这一行转发是 `FilesView` 在用的（它从 `TreeNode` 取 `FolderActions`），菜单搬走之后
 * 仍然留在这里。
 */
export type { NewKind, FolderActions, PendingCreate } from "./types";
