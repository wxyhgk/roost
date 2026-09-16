import { ArrowUpIcon, ListBulletIcon, QueueListIcon } from "@heroicons/react/24/outline";
import type { Session } from "../../shared/types";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, useMemo } from "react";
import { createPath } from "../../shared/api";
import { IconClose, IconPlus, IconRefresh, IconUpload } from "../../shared/icons";
import { useWorkspace } from "../../shared/store";
import { IconButton } from "../../shared/ui/IconButton";
import { Empty } from "../../shared/ui/Empty";
import { watchFiles } from "../../shared/api/fileWatch";
import { useUploadQueue } from "./useUploadQueue";
import { t } from "@roost/i18n";
import { useBrowseLocation } from "./useBrowseLocation";
import { Tree } from "./Tree";
import { Menu, MenuItem } from "./Menu";
import type { NewKind, PendingCreate } from "./types";
import type { FolderActions } from "./TreeNode";

export function FilesView() {
  const { sessions, selectedId } = useWorkspace("sessions", "selectedId");
  const session = sessions.find((s) => s.id === selectedId && !s.closed);
  return session ? <SessionFiles key={session.id} session={session} /> : <Empty title={t.files.browser.noSession} />;
}

function SessionFiles({ session }: { session: Session }) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<null | "file" | "dir" | "mol">(null);
  /*
    新建到**哪个目录**。工具栏的 + 用的是当前浏览目录，而右键菜单用的是被右键的
    那个目录——树形模式下后者可能深在好几层里，`directory` 永远是空串，指望它
    会把文件建到根上。
  */
  const [createIn, setCreateIn] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  /** 工具栏 + 弹出的三项菜单，坐标来自按钮的下沿。 */
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  /*
    换地方时要一并收拾的东西：搜索词、正在新建的条目、以及上一次的错误。
    原来导航、换模式、换根目录三处各抄了一遍，抄漏一处就会留下一个陈旧的错误提示。
  */
  const leaveBrowsingUi = useCallback(() => {
    setQuery("");
    setCreating(null);
    setCreateError(null);
    setCreateIn("");
  }, []);
  const { location, navigate, changeMode, rememberFile } =
    useBrowseLocation(session.id, session.cwd, leaveBrowsingUi);
  const directory = location.mode === "list" ? location.path : "";
  const [rev, setRev] = useState(0);
  // 终端里的 AI 改了文件，树要自己动。刷新按钮留着：监听可能起不来
  // （根目录没了、系统不支持递归监听），那时手动刷新是唯一的失效信号。
  const [watchStopped, setWatchStopped] = useState(false);
  // 重连放弃之后，点刷新既是取新数据，也是再试一次监听。
  const [watchAttempt, setWatchAttempt] = useState(0);
  useEffect(() => {
    setWatchStopped(false);
    return watchFiles(session.cwd, () => setRev(r => r + 1), () => setWatchStopped(true));
  }, [session.cwd, watchAttempt]);
  function refresh() {
    setRev(r => r + 1);
    if (watchStopped) setWatchAttempt(n => n + 1);
  }
  // 上传落盘会触发文件监听，树自己会刷新；这里再补一次，覆盖监听没起来的情况。
  const upload = useUploadQueue(session.cwd, refresh);
  const fileInput = useRef<HTMLInputElement>(null);
  /*
    选文件那一刻要传到哪。存 ref 而不是 state：从点菜单到 change 事件之间隔着一个
    原生文件对话框，那期间组件可能因为别的原因重渲染，而这次选择的目标早在打开
    对话框时就定死了。
  */
  const uploadDir = useRef("");
  const folder = useRef<FolderActions>({
    upload(dir) {
      uploadDir.current = dir;
      fileInput.current?.click();
    },
    create(dir, kind) {
      setCreateIn(dir);
      setCreating(kind);
      setCreateError(null);
    },
  }).current;
  const [dropping, setDropping] = useState(false);
  // 拖进来的必须是「文件」。树上的节点自己也可拖（拖去终端），
  // 不加这个判断会把拖动节点误当成上传。
  /*
    待命名的新条目交给树，由它就地渲染在目标目录里。**取消和提交分开**：提交失败时
    不能把这一行收掉，否则错误信息没地方显示、用户也没得改，所以只有 commit 成功
    才清 creating（见 commitCreate）。
  */
  const cancelCreate = useCallback(() => { setCreating(null); setCreateError(null); }, []);
  const pending = useMemo<PendingCreate | null>(
    () => (creating ? { dir: createIn, kind: creating, error: createError, commit: (name) => void commitCreate(name), cancel: cancelCreate } : null),
    // commitCreate 每次渲染都是新函数，但它读的都是当前的 state，不需要进依赖。
    // eslint 不在这个仓库里，这条注释就是那份说明。
    [creating, createIn, createError, cancelCreate], // eslint-disable-line
  );

  const isFileDrag = (event: ReactDragEvent) => event.dataTransfer.types.includes("Files");
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  async function commitCreate(raw: string) {
    if (!session || !creating) return;
    let name = raw.trim().replace(/^\/+/, "");
    if (name && creating === "mol" && !/\.mol$/i.test(name)) name += ".mol";
    if (!name) return;
    try {
      const created = await createPath(session.cwd, createIn ? `${createIn}/${name}` : name, creating === "mol" ? "file" : creating);
        setCreateError(null);
      setCreating(null);
      if (creating !== "dir") setPendingSelect(created.path);
      setRev((r) => r + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t.files.browser.createFailed);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 这一排、下面的面包屑、再下面的筛选框是三条叠在一起的工具栏，都是控件。
          前两条原来 12px、筛选框 13px，统一到 text-body。 */}
      <div role="group" aria-label={t.files.browser.modeLabel} className="flex shrink-0 gap-1 border-b border-border px-2.5 py-1">
        {([{ mode: "tree", label: t.files.browser.tree, Icon: QueueListIcon }, { mode: "list", label: t.files.browser.list, Icon: ListBulletIcon }] as const).map(({ mode, label, Icon }) => (
          <button key={mode} type="button" aria-pressed={location.mode === mode} onClick={() => changeMode(mode)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-body focus-visible:outline-2 ${location.mode === mode ? "bg-bg-active text-text" : "text-text-dim hover:bg-bg-hover"}`}>
            <Icon className="size-3.5" />{label}
          </button>
        ))}
      </div>
      {location.mode === "list" && (
        <nav aria-label={t.files.browser.pathLabel} className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <button type="button" title={t.files.browser.upDir} aria-label={t.files.browser.upDir} disabled={!directory}
            onClick={() => navigate(directory.split("/").slice(0, -1).join("/"))}
            className="grid size-6 shrink-0 place-items-center rounded text-text-dim hover:bg-bg-hover disabled:opacity-30">
            <ArrowUpIcon className="size-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-body">
            {[{ name: session.cwd.replaceAll('\\', '/').split("/").filter(Boolean).at(-1) || "/", path: "" },
              ...directory.split("/").filter(Boolean).map((name, i, parts) => ({ name, path: parts.slice(0, i + 1).join("/") }))].map((crumb, i) => (
              <span key={crumb.path} className="flex shrink-0 items-center gap-1">
                {i > 0 && <span className="text-text-dim">/</span>}
                <button type="button" title={crumb.path || session.cwd} aria-current={crumb.path === directory ? "location" : undefined}
                  className="rounded px-1 py-0.5 text-text hover:bg-bg-hover" onClick={() => navigate(crumb.path)}>{crumb.name}</button>
              </span>
            ))}
          </div>
        </nav>
      )}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={location.mode === "list" ? t.files.browser.filterList : t.files.browser.filterTree}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent"
        />
        <input ref={fileInput} type="file" multiple className="hidden" onChange={event => {
          const picked = [...(event.target.files ?? [])];
          event.target.value = "";
          upload.enqueue(picked, uploadDir.current);
        }} />
        <IconButton title={t.files.upload.button} onClick={() => folder.upload(directory)}>
          <IconUpload />
        </IconButton>
        {/* 自动同步停了就得说出来：一棵不再更新的树看起来和实时的一模一样。 */}
        <IconButton title={watchStopped ? t.files.browser.watchStopped : t.files.browser.refresh} onClick={refresh}>
          <span className="relative inline-flex">
            <IconRefresh />
            {watchStopped && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warning" />}
          </span>
        </IconButton>
        {/*
          + 不再直接开一个「文件」输入框：类型改由菜单决定之后，三种新建各有各的入口，
          和右键菜单是同一套。菜单开在按钮下沿，落点是当前浏览目录。
        */}
        <IconButton title={t.files.browser.create} onClick={(e) => {
            const r = (e as unknown as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect();
            setNewMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <IconPlus />
        </IconButton>
        {query && (
          <IconButton title={t.files.browser.clearFilter} onClick={() => setQuery("")}>
            <IconClose />
          </IconButton>
        )}
      </div>
      {/* 上传状态条：进行中的进度、同名的三选一、以及失败清单。 */}
      {upload.state.conflict ? (
        <div role="alertdialog" aria-label={t.files.upload.conflictTitle(upload.state.conflict.name)}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-warning-soft px-2.5 py-1.5 text-caption">
          <span className="min-w-0 flex-1 truncate text-text">{t.files.upload.conflictTitle(upload.state.conflict.name)}</span>
          {/* 覆盖不可撤销，所以永远由你来选，不设默认动作。 */}
          <button className="rounded px-2 py-0.5 text-text hover:bg-bg-hover" onClick={() => upload.resolve("rename")}>{t.files.upload.rename}</button>
          <button className="rounded px-2 py-0.5 text-danger hover:bg-bg-hover" onClick={() => upload.resolve("overwrite")}>{t.files.upload.overwrite}</button>
          <button className="rounded px-2 py-0.5 text-text-dim hover:bg-bg-hover" onClick={() => upload.resolve("skip")}>{t.files.upload.skip}</button>
        </div>
      ) : upload.state.active && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5 text-caption text-text-dim">
          <span className="min-w-0 flex-1 truncate">
            {t.files.upload.uploading(upload.state.active.name,
              Math.round((upload.state.active.loaded / Math.max(upload.state.active.total, 1)) * 100))}
            {upload.state.pending > 0 && ` · ${t.files.upload.queued(upload.state.pending)}`}
          </span>
          <span className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-bg-active">
            <span className="block h-full bg-accent transition-[width] duration-150"
              style={{ width: `${Math.round((upload.state.active.loaded / Math.max(upload.state.active.total, 1)) * 100)}%` }} />
          </span>
          <button className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-hover" onClick={upload.cancel}>{t.files.upload.cancel}</button>
        </div>
      )}
      {upload.state.failures.length > 0 && (
        <div role="alert" className="flex shrink-0 flex-col gap-0.5 border-b border-border bg-danger-soft px-2.5 py-1.5 text-caption text-danger">
          <div className="flex items-center gap-2">
            <span className="flex-1">{t.files.upload.failed(upload.state.failures.length)}</span>
            <button className="rounded px-1.5 py-0.5 hover:bg-bg-hover" onClick={upload.dismiss}>{t.files.upload.dismiss}</button>
          </div>
          {upload.state.failures.map(item => <div key={item.name} className="truncate opacity-90">{item.name}：{item.message}</div>)}
        </div>
      )}
      <div className="relative flex flex-1 flex-col overflow-auto bg-bg-panel"
        onDragOver={event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true); }}
        onDragLeave={event => { if (event.currentTarget === event.target) setDropping(false); }}
        onDrop={event => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDropping(false);
          upload.enqueue([...event.dataTransfer.files], directory);
        }}>
        {dropping && (
          <div className="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-bg-panel/80 text-caption text-text">
            {t.files.upload.dropHint}
          </div>
        )}
        {session ? (
          <Tree
            key={session.id}
            cwd={session.cwd}
            directory={directory}
            listMode={location.mode === "list"}
            onNavigate={navigate}
            sessionId={session.id}
            query={query}
            rev={rev}
            initialFile={location.file ?? null}
            onFileChange={rememberFile}
            pendingSelect={pendingSelect}
            onPendingSelectConsumed={() => setPendingSelect(null)}
            onMutated={() => setRev((r) => r + 1)}
            folder={folder}
            pending={pending}
          />
        ) : (
          <Empty title={t.files.browser.noSession} />
        )}
      </div>
      {newMenu && (
        <Menu x={newMenu.x} y={newMenu.y} onClose={() => setNewMenu(null)}>
          {(
            [
              ["file", t.files.menu.newFile],
              ["dir", t.files.menu.newFolder],
              ["mol", t.files.menu.newMolecule],
            ] as const satisfies readonly (readonly [NewKind, string])[]
          ).map(([kind, label]) => (
            <MenuItem key={kind} label={label} onClick={() => { setNewMenu(null); folder.create(directory, kind); }} />
          ))}
        </Menu>
      )}
    </div>
  );
}
