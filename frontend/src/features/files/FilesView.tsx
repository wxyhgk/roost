import { ArrowUpIcon, ListBulletIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { basename } from "../../shared/path";
import { bytes } from "../../shared/bytes";
import type { Session } from "../../shared/types";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, useMemo } from "react";
import { createPath } from "../../shared/api";
import { IconClose, IconPlus, IconRefresh, IconUpload } from "../../shared/icons";
import { useWorkspace } from "../../shared/store";
import { IconButton } from "../../shared/ui/IconButton";
import { Empty } from "../../shared/ui/Empty";
import { watchFiles } from "../../shared/api/fileWatch";
import { useUploadQueue } from "./useUploadQueue";
import { collectDropEntries, readDropTree, type DropTree } from "./dropUpload";
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
  /**
   * 光标正悬在树上的哪个目录。null = 不在任何目录上，落当前浏览目录。
   *
   * **唯一的一份真相**：每一行是不是高亮，由它推出来（见 TreeNode）。自己在每行存一份
   * 就得靠 dragenter/dragleave 配平，而 `dragleave` 在移到子元素时也会触发，配不平。
   */
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  /*
    拖出窗口、或者在别处松手时的兜底。

    那种情况下面板的 `dragleave` 同样判不出「真的离开了」（`target` 往往是树里的某一行），
    于是虚线框和目录高亮会一直挂着，直到你再拖一次才消。`dragend` / `drop` 挂在 window 上
    才收得干净——它们无论在哪里结束都会来。
  */
  useEffect(() => {
    const clear = () => { setDropping(false); setDropTargetDir(null); };
    /*
      `relatedTarget === null` 才是「离开了整个窗口」。

      光标在页面内部从一个元素移到另一个时 `dragleave` 也会来，那时 relatedTarget 是
      要进入的那个元素；只有真的移出窗口才为 null。不判这一条就会在树里移动时乱清。

      从 Finder 拖进来的外部拖放**不会**在我们窗口里触发 `dragend`（拖动源在 Finder），
      所以这条 dragleave 是「拖进来又拖走」唯一收得干净的地方。
    */
    const leave = (event: DragEvent) => { if (event.relatedTarget === null) clear(); };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("dragleave", leave);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragleave", leave);
    };
  }, []);
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
  /*
    拖进来的一批东西，展开之后先停在这儿等确认。

    **闸门是按「要花多久」设的，不是按带宽。** 上传队列是串行的，一个文件一条 HTTP
    请求；误拖一个 node_modules 就是上万次顺序往返，即使全在本机也要几分钟，而且你得
    先意识到出事了才会去点取消。所以超过阈值就先问一句——**在遍历阶段问，不是传到一半
    才发现**。
  */
  const [plan, setPlan] = useState<{ tree: DropTree; directory: string } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const CONFIRM_FILES = 500, CONFIRM_BYTES = 200 * 1024 * 1024;

  /** 先把目录逐级建出来，再把文件排进队列。后端的 mkdir 不是递归的，所以要一层层来。 */
  const startUpload = useCallback(async (tree: DropTree, directory: string) => {
    setPlan(null);
    setPlanError(null);
    const root = session?.cwd;
    if (!root) return;
    const join = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);
    for (const relative of tree.directories) {
      // 已经存在是正常的（拖第二次、或者目标里本来就有同名目录），不算失败。
      try { await createPath(root, join(directory, relative), "dir"); }
      catch (error) {
        const status = (error as { status?: number })?.status;
        if (status !== 409) { setPlanError((error as { message?: string })?.message ?? String(error)); return; }
      }
    }
    upload.enqueue(
      tree.files.map(item => ({ file: item.file, directory: join(directory, item.path.split("/").slice(0, -1).join("/")) })),
    );
  }, [session?.cwd, upload]);

  /** drop 回调里**同步**取 entry，再交给异步遍历——items 在回调返回后就失效了。 */
  const acceptDrop = useCallback((event: ReactDragEvent, directory: string) => {
    /*
      **提示的清除放在这儿，因为两条 drop 路径都经过它。**

      先前写在面板那个 `onDrop` 里，而落在目录行上时那个回调根本不会触发——行里
      `stopPropagation()` 了。于是松手之后虚线框和「松开即上传到 X」一直挂着，
      文件其实已经传完了。

      挂在 window 上的 `dragend` / `drop` 兜底也救不了这一条：`stopPropagation()`
      连原生事件一起拦住，而从 Finder 拖进来的外部拖放本来就不会在我们窗口里触发
      `dragend`（拖动的源头在 Finder）。
    */
    setDropping(false);
    setDropTargetDir(null);
    const entries = collectDropEntries(event.dataTransfer.items);
    const flat = [...event.dataTransfer.files];
    void (async () => {
      const tree = entries.length
        ? await readDropTree(entries)
        // 老浏览器没有 webkitGetAsEntry：退回平铺的文件列表，文件夹传不了但文件照传。
        : { files: flat.map(file => ({ path: file.name, file })), directories: [], totalBytes: flat.reduce((n, f) => n + f.size, 0), hidden: 0, stopped: false };
      if (!tree.files.length) return;
      if (tree.stopped || tree.files.length > CONFIRM_FILES || tree.totalBytes > CONFIRM_BYTES) setPlan({ tree, directory });
      else void startUpload(tree, directory);
    })();
  }, [startUpload]);
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
            {[{ name: basename(session.cwd) || "/", path: "" },
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
      <div className="relative flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        {/*
          拖放提示盖在**筛选框这一行**上，不盖树。

          它先前是浮在树顶上的一条，于是最上面那个目录被压掉半行——而那一行恰恰可能正是
          你想拖进去的目标。挪到这里：这一行在拖放期间没用，盖住零成本；高度不变，
          树也不会被推着走（拖到一半整棵树上下挪动，光标底下的目标就换人了）。
        */}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center bg-bg-panel px-2.5">
            <span className="min-w-0 flex-1 truncate rounded-md bg-accent/15 px-2 py-1 text-body text-accent">
              {dropTargetDir === null ? t.files.upload.dropHintFolder : t.files.upload.dropInto(dropTargetDir || ".")}
            </span>
          </div>
        )}
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
          upload.enqueue(picked.map(file => ({ file, directory: uploadDir.current })));
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
      {plan && (
        <div role="alert" className="flex shrink-0 flex-col gap-1 border-b border-border bg-bg-raised px-2.5 py-1.5 text-caption text-text">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {t.files.upload.confirmTitle(plan.tree.files.length, bytes(plan.tree.totalBytes))}
              {plan.tree.hidden > 0 && ` · ${t.files.upload.confirmHidden(plan.tree.hidden)}`}
            </span>
            <button className="shrink-0 rounded px-2 py-0.5 text-accent hover:bg-bg-hover"
              onClick={() => void startUpload(plan.tree, plan.directory)}>{t.files.upload.confirmStart}</button>
            <button className="shrink-0 rounded px-2 py-0.5 text-text-dim hover:bg-bg-hover"
              onClick={() => setPlan(null)}>{t.files.upload.confirmCancel}</button>
          </div>
          {plan.tree.stopped && <div className="text-warning">{t.files.upload.confirmTruncated}</div>}
        </div>
      )}
      {planError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-danger-soft px-2.5 py-1.5 text-caption text-danger">
          <span className="min-w-0 flex-1 truncate">{planError}</span>
          <button className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-hover" onClick={() => setPlanError(null)}>{t.files.upload.dismiss}</button>
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
        /* 节点接住时会 stopPropagation，所以这里还能收到就说明不在任何目录行上。 */
        onDragOver={event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true); setDropTargetDir(null); }}
        onDragLeave={event => { if (event.currentTarget === event.target) { setDropping(false); setDropTargetDir(null); } }}
        onDrop={event => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDropping(false);
          setDropTargetDir(null);
          acceptDrop(event, directory);
        }}>
        {/*
          拖放时的提示。**不能是一块盖住整棵树的半透明布**——原来是 `bg-bg-panel/80`
          铺满整个面板，于是拖进来之后你根本看不见自己悬在哪个目录上，目录那圈高亮也被
          压在它底下。看上去就像「没有目标，八成会落到当前目录」。

          所以：只描一圈虚线边框，不铺底；提示语贴在顶上而不是正中央（正中央正好压住树）；
          悬在某个目录上时**说出是哪个目录**，并且把面板这层的框收掉，让那一行的高亮独自
          说话。
        */}
        {/* 树上只留一圈虚线，说明「松手会落在这个面板里」。文字在上面那一行，见那里的说明。 */}
        {dropping && <div className="pointer-events-none absolute inset-1 z-10 rounded-lg border-2 border-dashed border-accent" />}
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
            onDropFiles={acceptDrop}
            dropTargetDir={dropTargetDir}
            onDropTargetChange={setDropTargetDir}
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
            <MenuItem key={kind} label={label} /* 同上：菜单异步归还焦点，输入框要等它。见 TreeNode.createIn。 */
            onClick={() => { setNewMenu(null); setTimeout(() => folder.create(directory, kind), 0); }} />
          ))}
        </Menu>
      )}
    </div>
  );
}
