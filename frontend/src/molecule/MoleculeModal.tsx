import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownTrayIcon, PaperAirplaneIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { readFilePreview, writeFile, FileWriteError } from '../shared/api/files';
import { moleculeChannel, type MoleculeFormat, type MoleculeWindow } from './bridge';
import { handoffMolecule } from './handoff';
import { replaceFirstSdfRecord, splitSdfRecords } from './sdf';
import { t } from '@roost/i18n';

/**
 * 编辑器资源没拉全时，浏览器给的是「Failed to fetch dynamically imported module: <地址>」
 * 这类原文——而且**报的是父模块的地址**，对着那个地址单独测往往是好的，对用户毫无用处。
 * 这里把它换成能照着做的话。
 */
const ASSET_FAILURE = /dynamically imported module|Importing a module script failed|Failed to fetch/i;

/**
 * 分子编辑器。
 *
 * **关掉不卸载,只是藏起来。**
 *
 * 编辑器活在一个 iframe 里(这道墙挡的是 Ketcher 在 document 上挂的 9 个 keydown 和
 * 整套剪贴板监听,不让它们和终端抢按键)。代价是 iframe 一销毁,整个 JS realm 跟着没:
 * 那 9 MB 代码的顶层执行结果、React 内部状态、wasm 实例、indigo 的 worker,全是 realm
 * 作用域的。HTTP 缓存留得住字节,留不住一个跑起来的 realm——所以每次重开都是冷启动。
 *
 * 于是 `open` 只切可见性。`visibility:hidden` 既不绘制也不可聚焦，但**保留布局尺寸**,
 * 这样再打开时 Ketcher 的画布不会因为尺寸从 0 变回来而重新排版。
 *
 * 注意:iframe 元素**不能换父节点**——重新挂载 DOM 位置会让浏览器重新加载它的文档,
 * 等于白留。所以这里靠"不卸载"保住它,而不是把它搬到别处去。
 */
export function MoleculeModal({ open, root, path, sessionId, onClose, onDirtyChange, onSaved }: {
  open: boolean; root: string; path: string; sessionId: string; onClose(): void;
  onDirtyChange(dirty: boolean): void; onSaved(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const mtime = useRef<number | null>(null);
  const source = useRef('');
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const busyRef = useRef(false);
  const initialized = useRef(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState(t.files.molecule.loading);
  const [notice, setNotice] = useState('');
  // 两个计数器是两件事：reload 只重新读盘（编辑器已经在了，不该重下十几兆资源），
  // frameEpoch 作为 iframe 的 key 把整个编辑器文档换掉——那是编辑器压根没起来时唯一的退路。
  const [reload, setReload] = useState(0);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const format: MoleculeFormat = /\.sdf$/i.test(path) ? 'sdf' : 'mol';
  const actions = useRef({ save: () => {}, close: () => {} });
  const api = () => (frame.current?.contentWindow as MoleculeWindow | null)?.moleculeEditor;

  useEffect(() => {
    alive.current = true;
    const listener = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== moleculeChannel) return;
      if (event.data.type === 'ready') setFrameReady(true);
      if (event.data.type === 'change' && initialized.current) {
        revision.current++; setDirty(true); setMessage(t.files.molecule.unsaved);
      }
      if (event.data.type === 'error') {
        const raw = String(event.data.message || '');
        setError(!raw ? t.files.molecule.loadFailed : ASSET_FAILURE.test(raw) ? t.files.molecule.assetsFailed : raw);
      }
      if (event.data.type === 'save') actions.current.save();
    };
    // message 始终收：编辑器藏起来的时候仍然可能报错（资源掉线、worker 崩），
    // 那些消息要照样落到 error 上，而不是丢掉之后等下次打开一脸茫然。
    window.addEventListener('message', listener);
    return () => {
      alive.current = false; request.current?.abort();
      window.removeEventListener('message', listener);
    };
  }, []);
  /*
    键盘和离开确认**只在打开时**挂。

    组件不再随关闭而卸载，所以这些监听如果一直挂着，关掉编辑器之后 Esc 和 Cmd+S
    仍然会被它吃掉——那两个键在终端里都有用。beforeunload 同理：藏着的编辑器留着
    一份陈旧的 dirty，会让整个页面莫名其妙关不掉。
  */
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); actions.current.close(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); actions.current.save(); }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (revision.current !== savedRevision.current || busyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('beforeunload', unload);
    };
  }, [open]);
  // 藏起来时对外一律报「干净」：文件树用它决定切换文件要不要拦一道确认，
  // 而关掉的编辑器不该再拦任何东西。
  useEffect(() => { onDirtyChange(open && dirty); }, [open, dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  /*
    `open` 是依赖之一：重新打开时必须回盘上再读一次。编辑器留着不等于内容还新鲜——
    这期间终端里的 AI 完全可能改过同一个文件。关闭时的未保存修改已经在 close() 里
    问过一次了，这里直接以磁盘为准。
  */
  useEffect(() => {
    if (!open || !frameReady) return;
    let cancelled = false;
    initialized.current = false; setReady(false); setError('');
    void readFilePreview(root, path).then(async file => {
      if (cancelled) return;
      if (file.binary || file.truncated) throw new Error(t.files.molecule.notPlainText(format));
      source.current = file.content;
      const records = format === 'sdf' ? splitSdfRecords(file.content) : [];
      setNotice(format === 'sdf' && records.length > 1 ? t.files.molecule.multiRecord(records.length) : '');
      await api()!.load(records.length > 1 ? records[0] : file.content, format);
      if (cancelled) return;
      mtime.current = file.mtime;
      revision.current = savedRevision.current = 0;
      initialized.current = true;
      setReady(true); setDirty(false); setConflict(false); setMessage(t.files.molecule.saved);
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : t.files.molecule.readFailed); });
    return () => { cancelled = true; };
  }, [open, frameReady, root, path, reload]);
  useEffect(() => {
    if (!open || frameReady) return;
    const timeout = setTimeout(() => setError(t.files.molecule.slowLoad), 60_000);
    return () => clearTimeout(timeout);
  }, [open, frameReady]);

  async function save(toAI = false) {
    if (!ready || busyRef.current || !api() || mtime.current === null) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage(t.files.molecule.saving);
    const version = revision.current;
    try {
      const edited = await api()!.save();
      const content = format === 'sdf' ? replaceFirstSdfRecord(source.current, edited) : edited;
      const result = await writeFile(root, path, content, mtime.current);
      mtime.current = result.mtime;
      savedRevision.current = version;
      if (!alive.current) return;
      setDirty(revision.current !== version); setConflict(false); setMessage(t.files.molecule.saved); onSaved();
      if (toAI) {
        setMessage(t.files.molecule.savingPreview);
        const png = await api()!.png(await api()!.molfile());
        const controller = new AbortController(); request.current = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try { await handoffMolecule(sessionId, `${root.replace(/\/$/, '')}/${path}`, png, controller.signal); }
        finally { clearTimeout(timeout); }
        if (alive.current) setMessage(t.files.molecule.handedOff);
      }
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof FileWriteError && err.status === 409) {
        setConflict(true); setError(t.files.molecule.conflict);
      } else setError(err instanceof Error ? err.message : t.files.molecule.actionFailed);
      setMessage(savedRevision.current === revision.current ? t.files.molecule.saved : t.files.molecule.unsaved);
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function close() {
    if (busyRef.current) return;
    if (revision.current !== savedRevision.current && !confirm(t.files.molecule.closeDirtyConfirm)) return;
    onClose();
  }
  async function download() {
    try {
      const content = await api()!.save();
      const url = URL.createObjectURL(new Blob([content], { type: format === 'sdf' ? 'chemical/x-mdl-sdfile' : 'chemical/x-mdl-molfile' }));
      const link = document.createElement('a'); link.href = url; link.download = path.replaceAll('\\', '/').split('/').at(-1)!.replace(format === 'sdf' ? /\.sdf$/i : /\.mol$/i, `${t.files.molecule.draftSuffix}.${format}`); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(String(err)); }
  }
  actions.current = { save: () => { void save(); }, close };
  const button = 'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed';
  return createPortal(
    /*
      关闭走 `invisible`（`visibility: hidden`）而不是卸载或 `display:none`：
      不绘制、不可聚焦、不进无障碍树，但**布局尺寸留着**——iframe 的盒子不塌成 0×0，
      Ketcher 的画布就不会在重新显示时因为尺寸跳变重排一次。
      `pointer-events-none` 是保险：一层看不见的全屏遮罩绝不能吃掉点击。
    */
    <div className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4${open ? '' : ' invisible pointer-events-none'}`}
      aria-hidden={open ? undefined : true}
      onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section role="dialog" aria-modal="true" aria-label={t.files.molecule.dialogLabel} className="flex h-[90vh] w-[min(1400px,96vw)] flex-col overflow-hidden rounded-xl border border-border bg-bg text-text shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={`${root}/${path}`}>{path}</div><div role="status" className="text-xs text-text-dim">{dirty ? '● ' : ''}{message}</div></div>
          <button className={button} disabled={!ready || busy || conflict} onClick={() => void save()}><ArrowDownTrayIcon className="size-4"/>{t.files.molecule.save}</button>
          <button className={`${button} bg-accent/15 text-accent`} disabled={!ready || busy || conflict} onClick={() => void save(true)}><PaperAirplaneIcon className="size-4"/>{t.files.molecule.handToAi}</button>
          <button className={button} aria-label={t.files.molecule.closeLabel} disabled={busy} onClick={close}><XMarkIcon className="size-5"/></button>
        </header>
        {error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-sm text-danger">
          <span className="flex-1">{error}</span>
          {ready && <button className={button} disabled={busy} onClick={() => void download()}>{t.files.molecule.downloadDraft}</button>}
          <button className={button} disabled={busy} onClick={() => {
            if (conflict || dirty) { if (!confirm(t.files.molecule.reloadDirtyConfirm)) return; }
            setError('');
            // 编辑器压根没起来时，重新读盘毫无意义——要换掉的是整个 iframe 文档。
            // 换 key 让 React 重建 iframe，比给同一个 src 再赋一次值可靠。
            if (!frameReady) { setReady(false); setFrameEpoch(epoch => epoch + 1); }
            else setReload(value => value + 1);
          }}>{conflict ? t.files.molecule.reloadRemote : t.files.molecule.reload}</button>
        </div>}
        {notice && <div role="status" className="shrink-0 border-b border-border px-4 py-2 text-sm text-text-dim">{notice}</div>}
        <div className="relative min-h-0 flex-1 bg-white">
          <iframe key={frameEpoch} ref={frame} src="/molecule.html" title={t.files.molecule.canvasLabel} className="h-full w-full border-0" />
          {/* 画布本身是白的，所以这层覆盖也用白底；文字走令牌而不是写死的 slate。 */}
          {(!ready || busy) && <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-text">{message}</div>}
        </div>
      </section>
    </div>, document.body,
  );
}
