import { memo, useRef, useState } from "react";
import { useLibraryRecovery } from "../library/hooks";
import { message, type Kind } from "../library/api";
import { exportJson } from "../library/export";
import { t } from "@roost/i18n";
import { useLocale } from "../../shared/locale";

export const LibraryRecovery = memo(function LibraryRecovery({ onOpen }: { onOpen: (kind: Kind, id: string) => void }) {
  useLocale(); // memo 组件不随父级重渲染，自己订阅语言变化。
  const client = useLibraryRecovery();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(message(e)); }
    finally { lock.current = false; setBusy(false); client.refreshBackups(); }
  }
  const backups = client.backups();
  if (!error && !client.storageError && !backups.length) return null;
  return <div className="max-h-64 shrink-0 overflow-auto border-b border-border p-2 text-caption text-text-dim">
    {(error || client.storageError) && <p role="alert">{error || client.storageError}</p>}
    {backups.length > 0 && <details open><summary>{t.notes.recovery.title(backups.length)}</summary>
      <p>{t.notes.recovery.hint}</p>
      <div className="max-h-32 overflow-auto">{backups.map(d => <div key={d.key} className="flex gap-2 py-1">
        <span className="min-w-0 flex-1 truncate">{d.value.title || d.value.text?.split("\n")[0] || t.notes.recovery.unnamed}</span>
        <button disabled={busy} onClick={() => void run(async () => { const restored = await client.restore(d); onOpen(restored.kind, restored.value.id); })}>{t.notes.recovery.restore}</button>
        <button onClick={() => exportJson(t.notes.recovery.exportFilename, d)}>{t.notes.recovery.export}</button>
        <button onClick={() => { if (window.confirm(t.notes.recovery.discardConfirm)) { try { client.discardBackup(d.key); } catch (e) { setError(message(e)); } } }}>{t.notes.recovery.discard}</button>
      </div>)}</div>
    </details>}
    {client.storageError && <button onClick={() => exportJson(t.notes.recovery.unsavedFilename, client.unsaved().map(d => ({ kind: d.kind, base: d.base, value: d.value })))}>{t.notes.recovery.exportUnsaved}</button>}
  </div>;
});
