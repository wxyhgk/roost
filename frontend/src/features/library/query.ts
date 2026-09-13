import { message, type Kind, type Page, type RecordData, type Summary } from "./api";
export type RecordChange = { kind: Kind; record: RecordData };
export type QuerySource = {
  list(kind: Kind, q: string, cursor?: string): Promise<Page>;
  subscribeRecords(fn: (event: RecordChange) => void): () => void;
  subscribeRefresh(fn: () => void): () => void;
};
const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
function update(page: Page, kind: Kind, q: string, r: RecordData): Page {
  const sources = kind === "notes" ? [r.text ?? ""] : [r.title ?? "", r.code ?? ""];
  const match = !r.deletedAt && sources.some(source => fold(source).includes(fold(q)));
  const previous = page.items.find(x => x.id === r.id);
  if (previous && previous.revision > r.revision) return page;
  const row: Summary = { id: r.id, revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt,
    title: kind === "notes" ? (r.text?.split("\n").find(l => l.trim())?.trim() ?? "").slice(0, 256) : r.title ?? "",
    summary: (kind === "notes" ? r.text ?? "" : r.code ?? "").slice(0, 160), ...(kind === "snippets" ? { lang: r.lang } : {}) };
  // Keep existing rows in place while editing; explicit refresh restores server ordering.
  const items = match ? previous ? page.items.map(x => x.id === r.id ? row : x) : [row, ...page.items] : page.items.filter(x => x.id !== r.id);
  return { ...page, items };
}
export class LibraryQuery {
  private state: Page & { loading: boolean; error: string } = { items: [], nextCursor: null, loading: false, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private stop?: () => void;
  private changes: RecordData[] = [];
  constructor(private source: QuerySource, private kind: Kind, private q: string) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(value: Partial<typeof this.state>) { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  start() {
    const offRecords = this.source.subscribeRecords(e => {
      if (e.kind !== this.kind) return;
      if (this.state.loading) this.changes.push(e.record);
      this.set(update(this.state, this.kind, this.q, e.record));
    });
    const offRefresh = this.source.subscribeRefresh(() => { void this.refresh(); });
    this.stop = () => { offRecords(); offRefresh(); this.generation++; };
    void this.refresh();
    return () => { this.stop?.(); this.stop = undefined; };
  }
  refresh = async () => {
    const seq = ++this.generation;
    const count = Math.max(1, Math.ceil(this.state.items.length / 50));
    this.changes = []; this.set({ loading: true, error: "" });
    try {
      let page: Page = { items: [], nextCursor: null };
      for (let i = 0; i < count; i++) {
        const next = await this.source.list(this.kind, this.q, page.nextCursor ?? undefined);
        if (seq !== this.generation) return;
        page = { items: [...new Map([...page.items, ...next.items].map(x => [x.id, x])).values()], nextCursor: next.nextCursor };
        if (!next.nextCursor) break;
      }
      for (const r of this.changes) page = update(page, this.kind, this.q, r);
      this.set({ ...page, loading: false });
    } catch (e) { if (seq === this.generation) this.set({ error: message(e), loading: false }); }
  };
  more = async () => {
    if (!this.state.nextCursor || this.state.loading) return;
    const seq = this.generation; this.changes = []; this.set({ loading: true, error: "" });
    try {
      const next = await this.source.list(this.kind, this.q, this.state.nextCursor!);
      if (seq !== this.generation) return;
      let page: Page = { items: [...new Map([...this.state.items, ...next.items].map(x => [x.id, x])).values()], nextCursor: next.nextCursor };
      for (const r of this.changes) page = update(page, this.kind, this.q, r);
      this.set({ ...page, loading: false });
    } catch (e) { if (seq === this.generation) this.set({ error: message(e), loading: false }); }
  };
}
