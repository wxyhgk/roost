import { useCallback, useEffect, useRef, useState } from "react";
import { listDir, type FileNode } from "../../shared/api";
import { Empty } from "../../shared/ui/Empty";
import { t } from "@roost/i18n";
import { FilePreviewModal } from "./FilePreviewModal";
import { TreeNode } from "./TreeNode";
import type { FolderActions, PendingCreate } from "./types";
import { NewEntryRow } from "./NewEntryRow";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { useFileViewer } from "./useFileViewer";
import { createCoalescedLoad } from "./coalescedLoad";

/**
 * 多久之后把「加载中」换成「仍在加载」。
 *
 * 挑在人开始怀疑是不是卡住的那个点上，而不是贴着请求超时（45 秒）设——那时候
 * 再说已经晚了，用户早就去点别处了。这只影响文案和重试入口，不影响请求本身。
 */
const SLOW_AFTER_MS = 6000;

export function Tree({
  cwd,
  directory,
  listMode,
  onNavigate,
  sessionId,
  query,
  rev,
  initialFile,
  onFileChange,
  pendingSelect,
  onPendingSelectConsumed,
  onMutated,
  folder,
  pending,
}: {
  cwd: string;
  directory: string;
  listMode: boolean;
  onNavigate: (path: string) => void;
  sessionId: string;
  query: string;
  rev: number;
  initialFile: string | null;
  onFileChange: (path: string | null) => void;
  pendingSelect: string | null;
  onPendingSelectConsumed: () => void;
  onMutated: () => void;
  /** 右键菜单里落在目录上的那几项，由 FilesView 实现（上传队列和新建行都在那儿）。 */
  folder: FolderActions;
  pending: PendingCreate | null;
}) {
  const loadedDirectory = useRef(directory);
  const [loading, setLoading] = useState(true);
  /** 等超过这个时间还没回来，就换一套说法并给出重试入口。远小于请求本身的超时上限。 */
  const [slow, setSlow] = useState(false);
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  /*
    「正在看哪个文件」整个搬去了 useFileViewer。这棵树和它只在两个点相接：
    列表要知道高亮哪一行，点一行要能打开。
  */
  const viewer = useFileViewer({
    cwd,
    sessionId,
    initialFile,
    onFileChange,
    onSaved: onMutated,
  });
  const { selected } = viewer;

  useEffect(() => {
    if (pendingSelect) {
      viewer.open(pendingSelect);
      onPendingSelectConsumed();
    }
  }, [pendingSelect, onPendingSelectConsumed, viewer.open]);

  function handleRenamed(oldPath: string, newPath: string) {
    viewer.rename(oldPath, newPath);
    onMutated();
  }

  function handleDeleted(path: string, isDir: boolean) {
    // 删掉的正是打开着的那个（或者它的上级目录）：关掉，否则预览里留着一份
    // 已经不存在的内容，保存还会把它写回去。
    if (selected === path || (isDir && selected?.startsWith(`${path}/`))) viewer.close();
    onMutated();
  }
  const q = query.trim().toLowerCase();
  // 树形保留目录以便查找子项；列表只过滤当前这一层。
  const visible = q ? nodes.filter((n) => (!listMode && n.kind === "dir") || n.name.toLowerCase().includes(q)) : nodes;

  /*
    「导航」和「刷新」是两件事，必须分开处理。

    换目录、换根是**导航**：之前那个请求的结果已经没人要了，该当场打断——留着它只会
    占住连接，并在慢链路上排在新请求前面。

    文件变化通知是**刷新**：想要的是同一个目录的最新内容。原来它和导航走同一条路，
    `rev` 一变就打断在途请求重发；而后端的去抖是 150ms，终端里跑一次构建时事件流约
    6.7 帧/秒，单程却要 330ms——**每个响应都在到达前被下一帧掐掉**，整个构建期间树
    一次都不更新，纯烧带宽。

    所以刷新改成排队：在途就记一笔，等它自己回来再取一次，多次刷新合并成一次。
    这样刷新频率由**实际往返时间**决定，快链路上仍然每次都刷，慢链路上自动合并——
    比去抖多少毫秒那种猜一个常数的做法准，因为没有常数可猜错。
  */
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (loadedDirectory.current !== directory) {
      loadedDirectory.current = directory;
      setLoading(true);
      setNodes([]);
    }
    /*
      等久了要说一声。「正在正常地等」和「这次请求不会回来了」在界面上完全同形，
      都是一个「加载中…」，用户分不出自己该继续等还是该动手。计时器只换文案、
      只多给一个重试入口，**不打断请求**——慢链路上它该继续等自己完成。
    */
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const feed = createCoalescedLoad((signal) => listDir(cwd, directory, signal), {
      start() {
        setError(null);
        setSlow(false);
        clearTimeout(slowTimer);
        slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      },
      data: setNodes,
      error(reason) { setError(reason instanceof Error ? reason.message : t.files.tree.readDirFailed); },
      settled() {
        clearTimeout(slowTimer);
        setLoading(false);
        setSlow(false);
      },
    });
    refresh.current = feed.load;
    feed.load();
    return () => {
      clearTimeout(slowTimer);
      refresh.current = null;
      feed.dispose();
    };
  }, [cwd, directory]);

  // 文件变化只是「再取一次」的信号，不是换地方。挂载时那一次由上面的 effect 负责。
  const seenRev = useRef(rev);
  useEffect(() => {
    if (seenRev.current === rev) return;
    seenRev.current = rev;
    refresh.current?.();
  }, [rev]);

  /*
    空白处的右键菜单。

    条目上的那个菜单在 `TreeNode` 里 stopPropagation，所以点在行上不会漏到这儿来；
    能到这儿的只有行与行之外的地方——最后一行下面的空白、以及空目录/加载中/出错时
    的那几块占位。目标目录就是**眼下正在看的这个**（树形模式下是根），和工具栏的
    ＋ 与上传按钮一致。
  */
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const closeBlankMenu = useCallback(() => setBlankMenu(null), []);



  return (
    <>
      {viewer.linkError && <div role="alert" className="shrink-0 break-words border-b border-border p-3 text-xs text-danger">{viewer.linkError}<button type="button" className="ml-2 underline" onClick={viewer.dismissLinkError}>{t.files.preview.close}</button></div>}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onContextMenu={(e) => {
          e.preventDefault();
          setBlankMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {loading ? (
          slow
            ? <Empty title={t.files.tree.slow} hint={t.files.tree.slowHint}
                action={<button type="button" className="rounded px-2 py-1 text-body text-text hover:bg-bg-hover" onClick={onMutated}>{t.files.tree.retry}</button>} />
            : <Empty title={t.files.tree.loading} />
        ) : error ? (
          <div className="px-2.5 py-2 text-body text-danger">{error}
            <button className="ml-2 rounded px-2 py-1 text-text hover:bg-bg-hover" onClick={onMutated}>{t.files.tree.retry}</button>
          </div>
        /* 空目录也要能长出新建行，所以 pending 落在根上时不走 Empty 那条分支。 */
        ) : visible.length === 0 && pending?.dir !== directory ? <Empty title={nodes.length === 0 ? t.files.tree.empty : t.files.tree.noMatch} /> : <ul className="file-tree">
          {pending?.dir === directory && (
            <NewEntryRow depth={0} kind={pending.kind} error={pending.error}
              onCommit={pending.commit} onCancel={pending.cancel} />
          )}
          {visible.map((n) => (
            <TreeNode
              key={n.path}
              cwd={cwd}
              sessionId={sessionId}
              node={n}
              depth={0}
              onNavigate={listMode ? onNavigate : undefined}
              selected={selected}
              onSelect={viewer.open}
              query={query}
              rev={rev}
              onRenamed={handleRenamed}
              onDeleted={handleDeleted}
              folder={folder}
              pending={pending}
            />
          ))}
        </ul>}
      </div>
      {blankMenu && (
        <Menu x={blankMenu.x} y={blankMenu.y} onClose={closeBlankMenu}>
          <MenuItem label={t.files.menu.newFile} onClick={() => { closeBlankMenu(); folder.create(directory, "file"); }} />
          <MenuItem label={t.files.menu.newFolder} onClick={() => { closeBlankMenu(); folder.create(directory, "dir"); }} />
          <MenuItem label={t.files.menu.newMolecule} onClick={() => { closeBlankMenu(); folder.create(directory, "mol"); }} />
          <MenuItem label={t.files.menu.uploadHere} onClick={() => { closeBlankMenu(); folder.upload(directory); }} />
          <MenuSeparator />
          <MenuItem label={t.files.menu.refresh} onClick={() => { closeBlankMenu(); onMutated(); }} />
        </Menu>
      )}
      {/* 归外部编辑器管的文件交给 Shell 上那个长命的宿主，这里只渲染轻量的文本预览。 */}
      {selected && !viewer.handledExternally && (
        <FilePreviewModal
          key={selected}
          preview={viewer.preview}
          previewError={viewer.previewError}
          selected={selected}
          cwd={viewer.root}
          onClose={viewer.close}
          onDirtyChange={viewer.notePreviewDirty}
          initialLine={viewer.linkRequest?.path === selected ? viewer.linkRequest.line ?? null : null}
          onInitialLineConsumed={viewer.consumeLinkLine}
        />
      )}
    </>
  );
}
