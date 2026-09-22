import type { RecordChange } from "./query";
import { uid } from "../../shared/uid";
import { content, LibraryError, message, request, same, type Content, type Kind, type Page, type RecordData, type Transport } from "./api";
import { t, type Messages } from "@roost/i18n";
/** 草稿保存状态机的标识。显示文案在 t.library.saveState，键即标识。 */
export type SaveState = keyof Messages["library"]["saveState"];
export type Draft = { key: string; kind: Kind; base: RecordData; value: RecordData; state: SaveState; error?: string; current?: RecordData; deleted?: boolean; generation: number; timer?: ReturnType<typeof setTimeout>; firstEdit?: number; pending?: Promise<void>; isNew?: boolean; creating?: RecordData; deleting?: boolean };
export type SavedDraft = { key: string; kind: Kind; base: RecordData; value: RecordData; isNew?: boolean; creating?: RecordData; savedAt: number };
export class LibraryClient {
  libraryId = "";
  error = "";
  storageError = "";
  private channels = new Map<string, { version: number; listeners: Set<() => void> }>();
  private backupCache?: SavedDraft[];
  private pendingKeys = { notes: "", snippets: "" };
  subscribeChannel = (key: string, fn: () => void) => {
    const channel = this.channel(key); channel.listeners.add(fn);
    return () => { channel.listeners.delete(fn); };
  };
  channelSnapshot = (key: string) => this.channel(key).version;
  private channel(key: string) {
    let channel = this.channels.get(key);
    if (!channel) { channel = { version: 0, listeners: new Set() }; this.channels.set(key, channel); }
    return channel;
  }
  private notify(key: string) { const channel = this.channels.get(key); if (!channel) return; channel.version++; channel.listeners.forEach(fn => fn()); }
  refreshBackups = () => { this.backupCache = undefined; this.notify("recovery"); };
  private recordListeners = new Set<(event: RecordChange) => void>();
  private refreshListeners = new Set<() => void>();
  private active = new Map<string, number>();
  private refreshing?: Promise<void>;
  drafts = new Map<string, Draft>();
  private starting?: Promise<void>;
  private verified = false;
  constructor(public api: Transport = request, public storage?: Storage) {
    try { this.libraryId = storage?.getItem("roost-library-last-id") ?? ""; } catch { /* Network can still initialize. */ }
  }
  private emit(d: Draft) {
    this.notify(`${d.kind}:${d.value.id}`);
    // The pending list only needs membership changes. Its rows read their own draft.
    const keys = this.unsaved(d.kind).map(row => row.value.id).join(",");
    if (keys !== this.pendingKeys[d.kind]) { this.pendingKeys[d.kind] = keys; this.notify(`pending:${d.kind}`); }
  }
  subscribeRecords = (fn: (event: RecordChange) => void) => { this.recordListeners.add(fn); return () => { this.recordListeners.delete(fn); }; };
  subscribeRefresh = (fn: () => void) => { this.refreshListeners.add(fn); return () => { this.refreshListeners.delete(fn); }; };
  private recordChanged(kind: Kind, record: RecordData) { this.recordListeners.forEach(fn => fn({ kind, record })); }
  unsaved(kind?: Kind) { return [...this.drafts.values()].filter(d => d.state !== "saved" && (!kind || d.kind === kind)); }
  watch(kind: Kind, id: string) {
    const key = `${kind}:${id}`; this.active.set(key, (this.active.get(key) ?? 0) + 1);
    return () => { const count = (this.active.get(key) ?? 1) - 1; if (count) this.active.set(key, count); else this.active.delete(key); this.trim(); };
  }
  private trim() {
    const clean = [...this.drafts.entries()].filter(([key, d]) => !this.active.has(key) && d.state === "saved" && !d.pending);
    for (const [key] of clean.slice(0, Math.max(0, clean.length - 40))) this.drafts.delete(key);
  }
  async init() {
    if (this.verified) return;
    if (!this.starting) this.starting = this.api<{libraryId: string}>("library/info").then(info => { if (this.libraryId && this.libraryId !== info.libraryId && this.drafts.size) throw new Error(t.library.error.libraryChanged);
      this.libraryId = info.libraryId; this.verified = true; this.error = "";
      try { this.storage?.setItem("roost-library-last-id", info.libraryId); } catch { /* Draft persistence reports storage failure. */ }
      this.refreshBackups(); }).catch(e => { this.error = message(e); this.notify("recovery"); throw e; }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async list(kind: Kind, q = "", cursor?: string): Promise<Page> {
    await this.init();
    const params = new URLSearchParams({ limit: "50", q });
    if (cursor) params.set("cursor", cursor);
    return this.api<Page>(`${kind}?${params}`);
  }
  private prefix() { return `roost-library-draft:${this.libraryId}:`; }
  private persist(d: Draft) {
    const oldError = this.storageError;
    try {
      if (!this.storage) throw new Error(t.library.error.storageUnavailable);
      if (d.state === "saved") this.storage.removeItem(this.prefix() + d.key);
      else this.storage.setItem(this.prefix() + d.key, JSON.stringify({ key: d.key, kind: d.kind, base: d.base, value: d.value, isNew: d.isNew, creating: d.creating, savedAt: Date.now() } satisfies SavedDraft));
      this.storageError = "";
    } catch { this.storageError = t.library.error.backupFailed; }
    if (oldError !== this.storageError) this.notify("recovery");
  }
  backups(): SavedDraft[] {
    if (this.backupCache) return this.backupCache;
    if (!this.storage) return [];
    const items: SavedDraft[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key || (!key.startsWith(this.prefix()) && !key.startsWith("roost-library-draft::"))) continue;
      try {
        const d = JSON.parse(this.storage.getItem(key)!);
        if (key.startsWith("roost-library-draft::") && !d.isNew) continue;
        if ((d.kind === "notes" || d.kind === "snippets") && d.value?.id && d.base?.id && typeof d.key === "string" && ![...this.drafts.values()].some(x => x.key === d.key)) items.push(d);
      } catch { /* Leave malformed backups untouched for export. */ }
    }
    return this.backupCache = items.sort((a, b) => b.savedAt - a.savedAt);
  }
  get(kind: Kind, id: string) { return this.drafts.get(`${kind}:${id}`); }
  async open(kind: Kind, id: string): Promise<Draft> {
    await this.init();
    const existing = this.get(kind, id);
    if (existing) { await this.refresh(existing); return existing; }
    const value = await this.api<RecordData>(`${kind}/${encodeURIComponent(id)}`);
    // A concurrent detail request must not replace a draft created in the meantime.
    if (this.get(kind, id)) return this.get(kind, id)!;
    const d: Draft = { key: uid(), kind, base: value, value, state: "saved", generation: 0 };
    this.drafts.set(`${kind}:${id}`, d); this.emit(d); return d;
  }
  async restore(saved: SavedDraft) {
    await this.init();
    const existing = this.get(saved.kind, saved.value.id);
    if (existing && existing.state !== "saved") throw new Error(t.library.error.draftEditing);
    // Copy to a new key: another window may still own the original backup.
    const d: Draft = { ...saved, key: uid(), state: "unsaved", generation: 0 };
    this.drafts.set(`${d.kind}:${d.value.id}`, d); this.persist(d); this.emit(d);
    if (d.isNew) await this.flush(d);
    else { await this.refresh(d); if (d.state === "unsaved") await this.flush(d); }
    return d;
  }
  async create(kind: Kind, fields: Content): Promise<Draft> {
    let connectionError: unknown;
    try { await this.init(); } catch (e) { connectionError = e; }
    const value = { id: uid(), revision: 0, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, ...fields };
    const d: Draft = { key: uid(), kind, base: value, value, state: "unsaved", generation: 0, isNew: true };
    this.drafts.set(`${kind}:${value.id}`, d); this.persist(d); this.emit(d);
    if (connectionError) { this.fail(d, connectionError); this.persist(d); this.emit(d); }
    else await this.flush(d);
    return d;
  }
  edit(d: Draft, fields: Partial<RecordData>) {
    if (d.deleting) return;
    d.value = { ...d.value, ...fields }; d.generation++;
    if (d.state !== "conflict" && d.state !== "failed") d.state = d.pending ? "saving" : "unsaved";
    this.persist(d); this.emit(d);
    if (d.state === "conflict" || d.state === "failed") return;
    d.firstEdit ??= Date.now();
    clearTimeout(d.timer);
    d.timer = setTimeout(() => { void this.flush(d); }, Math.max(0, Math.min(500, 2000 - (Date.now() - d.firstEdit))));
  }
  async flush(d: Draft): Promise<void> {
    clearTimeout(d.timer);
    if (d.pending) return d.pending;
    if (d.state === "saved" || d.state === "conflict" || d.deleting) return;
    d.firstEdit = undefined;
    const generation = d.generation;
    // Reuse the original POST body on retries even if more text has been typed.
    const target = d.isNew ? (d.creating ??= { ...d.value }) : { ...d.value };
    d.state = "saving"; d.error = undefined; this.persist(d); this.emit(d);
    d.pending = (async () => {
      try {
        await this.init();
        let result: RecordData;
        try {
          result = await this.api<RecordData>(d.isNew ? d.kind : `${d.kind}/${encodeURIComponent(d.value.id)}`, d.isNew ? "POST" : "PATCH", d.isNew ? { id: target.id, ...content(d.kind, target) } : { revision: d.base.revision, ...content(d.kind, target) });
        } catch (e) {
          if (e instanceof LibraryError && e.status === 409 && e.current && !e.current.deletedAt && same(d.kind, e.current, target)) result = e.current;
          else throw e;
        }
        d.base = result; d.isNew = false; d.creating = undefined;
        d.value = generation === d.generation && same(d.kind, d.value, target) ? result : { ...d.value, revision: result.revision, createdAt: result.createdAt, updatedAt: result.updatedAt };
        d.state = same(d.kind, d.value, result) ? "saved" : "unsaved";
        d.current = undefined; d.deleted = false; this.recordChanged(d.kind, result); this.emit(d);
      } catch (e) { this.fail(d, e); }
      finally { d.pending = undefined; this.persist(d); this.emit(d); }
      if (d.state === "unsaved") await this.flush(d);
    })();
    return d.pending;
  }
  private fail(d: Draft, e: unknown) {
    d.error = message(e);
    if (e instanceof LibraryError && (e.status === 409 || e.status === 410 || e.status === 404)) {
      d.state = "conflict"; d.current = e.current; d.deleted = e.status === 410 || e.status === 404;
      d.error = d.deleted ? t.library.error.remoteDeleted : t.library.error.remoteChanged;
    } else {
      d.state = "failed";
      if (e instanceof LibraryError && e.status === 503) d.error = t.library.error.serverBusy;
    }
  }
  async refresh(d: Draft) {
    if (d.pending || d.isNew || d.deleting) return;
    const generation = d.generation;
    const revision = d.base.revision;
    try {
      await this.init();
      const remote = await this.api<RecordData>(`${d.kind}/${encodeURIComponent(d.value.id)}`);
      if (d.pending || d.deleting || revision !== d.base.revision) return;
      if (d.state === "saved" && generation === d.generation) {
        d.base = remote; d.value = remote; d.error = undefined;
      } else if (remote.revision !== d.base.revision) {
        clearTimeout(d.timer);
        if (same(d.kind, d.value, remote)) { d.base = remote; d.value = remote; d.state = "saved"; d.current = undefined; d.error = undefined; }
        else { d.state = "conflict"; d.current = remote; d.error = t.library.error.updatedElsewhere; }
      }
    } catch (e) {
      if (!d.pending && revision === d.base.revision) { clearTimeout(d.timer); this.fail(d, e); }
    }
    if (d.state === "saved") this.recordChanged(d.kind, d.base);
    this.persist(d); this.emit(d);
  }
  async retry(d: Draft) {
    if (d.state === "conflict") return;
    if (!d.isNew) await this.refresh(d);
    if (d.state === "failed") d.state = "unsaved";
    await this.flush(d);
  }
  adopt(d: Draft) {
    if (!d.current || d.deleted || d.pending) return;
    clearTimeout(d.timer); d.base = d.current; d.value = d.current; d.current = undefined;
    d.state = "saved"; d.error = undefined; d.generation++; this.persist(d); this.recordChanged(d.kind, d.base); this.emit(d);
  }
  async copy(d: Draft) { return this.create(d.kind, content(d.kind, d.value)); }
  async remove(d: Draft) {
    clearTimeout(d.timer);
    if (d.pending) await d.pending;
    if (d.isNew || d.state !== "saved") throw new Error(t.library.error.deleteBlocked);
    d.deleting = true; this.emit(d);
    try {
      const tomb = await this.api<{revision: number; deletedAt: number}>(`${d.kind}/${encodeURIComponent(d.value.id)}`, "DELETE", { revision: d.base.revision });
      this.recordChanged(d.kind, { ...d.base, ...tomb });
      this.drafts.delete(`${d.kind}:${d.value.id}`); this.storage?.removeItem(this.prefix() + d.key); this.emit(d);
    } catch (e) { this.fail(d, e); this.persist(d); this.emit(d); throw e; }
    finally { d.deleting = false; this.emit(d); }
  }
  discardBackup(key: string) {
    this.storage?.removeItem(this.prefix() + key); this.storage?.removeItem("roost-library-draft::" + key); this.refreshBackups();
  }
  persistAll() { this.drafts.forEach(d => { if (d.state !== "saved") this.persist(d); }); }
  refreshAll() {
    if (this.refreshing) return this.refreshing;
    this.refreshListeners.forEach(fn => fn());
    const queue = [...this.drafts.entries()].filter(([key, d]) => this.active.has(key) || d.state !== "saved").map(([, d]) => d);
    this.refreshing = Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) { const d = queue.shift(); if (d) await this.refresh(d); }
    })).then(() => {}).finally(() => { this.refreshing = undefined; this.trim(); });
    return this.refreshing;
  }
  dispose() { this.drafts.forEach(d => clearTimeout(d.timer)); this.channels.clear(); this.recordListeners.clear(); this.refreshListeners.clear(); }
}
