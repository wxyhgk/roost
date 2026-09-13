import { ArrowUpIcon, ListBulletIcon, QueueListIcon } from "@heroicons/react/24/outline";
import type { Session } from "../../shared/types";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
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
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  /*
    换地方时要一并收拾的东西：搜索词、正在新建的条目、以及上一次的错误。
    原来导航、换模式、换根目录三处各抄了一遍，抄漏一处就会留下一个陈旧的错误提示。
  */
  const leaveBrowsingUi = useCallback(() => {
    setQuery("");
    setCreating(null);
    setCreateName("");
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
      setCreateName("");
      setCreateError(null);
    },
  }).current;
  const [dropping, setDropping] = useState(false);
  // 拖进来的必须是「文件」。树上的节点自己也可拖（拖去终端），
  // 不加这个判断会把拖动节点误当成上传。
  const isFileDrag = (event: ReactDragEvent) => event.dataTransfer.types.includes("Files");
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  async function commitCreate() {
    if (!session || !creating) return;
    let name = createName.trim().replace(/^\/+/, "");
    if (name && creating === "mol" && !/\.mol$/i.test(name)) name += ".mol";
    if (!name) return;
    try {
      const created = await createPath(session.cwd, createIn ? `${createIn}/${name}` : name, creating === "mol" ? "file" : creating);
      setCreateName("");
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
      <div role="group" aria-label={t.files.browser.modeLabel} className="flex shrink-0 gap-1 border-b border-border px-2.5 py-1">
        {([{ mode: "tree", label: t.files.browser.tree, Icon: QueueListIcon }, { mode: "list", label: t.files.browser.list, Icon: ListBulletIcon }] as const).map(({ mode, label, Icon }) => (
          <button key={mode} type="button" aria-pressed={location.mode === mode} onClick={() => changeMode(mode)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs focus-visible:outline-2 ${location.mode === mode ? "bg-bg-active text-text" : "text-text-dim hover:bg-bg-hover"}`}>
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
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs">
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
        <IconButton title={t.files.browser.create} onClick={() => {
            setCreateError(null);
            setCreateIn(directory);
            setCreating((v) => (v ? null : "file"));
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
      {creating && session && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            {(["file", "dir", "mol"] as const).map((kind) => (
              <button
                key={kind}
                className={`shrink-0 rounded px-2 py-0.5 text-caption ${
                  creating === kind ? "bg-bg-active text-text" : "text-text-dim hover:bg-bg-hover hover:text-text"
                }`}
                onClick={() => setCreating(kind)}
              >
                {kind === "file" ? t.files.browser.kindFile : kind === "mol" ? t.files.browser.kindMol : t.files.browser.kindDir}
              </button>
            ))}
            <input
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitCreate();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(null);
                  setCreateName("");
                  setCreateError(null);
                }
              }}
              placeholder={creating === "mol" ? t.files.browser.molPlaceholder : creating === "file" ? t.files.browser.filePlaceholder : t.files.browser.dirPlaceholder}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent"
            />
          </div>
          {/* 目标不是眼前这个目录时必须写出来：新建行在面板顶上，而右键的可能是深处某个文件夹。 */}
          {createIn !== directory && <div className="truncate text-caption text-text-dim">{t.files.browser.createIn(createIn || ".")}</div>}
          {createError && <div className="text-caption text-danger">{createError}</div>}
        </div>
      )}
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
          />
        ) : (
          <Empty title={t.files.browser.noSession} />
        )}
      </div>
    </div>
  );
}
