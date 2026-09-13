import { planImageInsertion, type ImageInsertion } from '@roost/cli-adapters';
import { apiErrorFrom } from '../../shared/api/errors';
import { t } from "@roost/i18n";

export type PasteTarget = { sessionId: string; instanceId: string; epoch: number };
export type ImagePasteState = { phase: 'uploading' | 'confirm' | 'inserted' | 'error'; message: string; preview?: string } | null;
type Attachment = { sessionId: string; instanceId: string; path: string; insertion: ImageInsertion };
type Options = {
  target(): PasteTarget | null;
  send(data: string): void;
  state(value: ImagePasteState): void;
  upload?: (file: File, target: PasteTarget, signal: AbortSignal) => Promise<Attachment>;
  preview?: (file: File) => string;
  revoke?: (url: string) => void;
};

export async function uploadSessionImage(file: File, target: PasteTarget, signal: AbortSignal): Promise<Attachment> {
  const body = new FormData(); body.append('file', file); body.append('instanceId', target.instanceId);
  const res = await fetch(`/api/sessions/${encodeURIComponent(target.sessionId)}/attachments`, { method: 'POST', body, signal });
  if (!res.ok) {
    const failure = await apiErrorFrom(res);
    throw new Error(t.terminal.paste.uploadFailed(res.status, failure.message));
  }
  return res.json();
}

/** Captures only image pastes. Connection ownership stays with useTerminal. */
export function createImagePaste(options: Options) {
  let controller: AbortController | null = null;
  let pending: { target: PasteTarget; data: string } | null = null;
  let preview: string | undefined;
  let disposed = false;
  const matches = (captured: PasteTarget) => {
    const now = options.target();
    return !disposed && now !== null && now.sessionId === captured.sessionId && now.instanceId === captured.instanceId && now.epoch === captured.epoch;
  };
  const revoke = () => { if (preview) (options.revoke ?? URL.revokeObjectURL)(preview); preview = undefined; };
  function cancel() {
    controller?.abort(); controller = null; pending = null; revoke();
    if (!disposed) options.state(null);
  }
  function invalidate() {
    const hadPending = Boolean(controller || pending);
    cancel();
    if (hadPending && !disposed) options.state({ phase: 'error', message: t.terminal.paste.connectionChanged });
  }
  function insert() {
    if (!pending) return;
    if (!matches(pending.target)) { invalidate(); return; }
    options.send(pending.data);
    pending = null;
    options.state({ phase: 'inserted', message: t.terminal.paste.inserted, preview });
  }
  async function paste(event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault' | 'stopImmediatePropagation'>) {
    const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!files.length || disposed) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (controller || pending) return; // Preserve the visible in-progress attachment.
    revoke();
    const fail = (message: string) => options.state({ phase: 'error', message, preview });
    if (files.length !== 1) { fail(t.terminal.paste.oneAtATime); return; }
    const file = files[0].getAsFile();
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { fail(t.terminal.paste.unsupportedType); return; }
    if (file.size > 10 * 1024 * 1024) { fail(t.terminal.paste.tooLarge); return; }
    const target = options.target();
    if (!target) { fail(t.terminal.paste.notConnected); return; }
    const request = new AbortController(); controller = request;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 30_000);
    try {
      preview = (options.preview ?? URL.createObjectURL)(file);
      options.state({ phase: 'uploading', message: t.terminal.paste.uploading, preview });
      const attachment = await (options.upload ?? uploadSessionImage)(file, target, request.signal);
      if (controller !== request || disposed) return;
      if (!matches(target) || attachment.sessionId !== target.sessionId || attachment.instanceId !== target.instanceId) {
        invalidate(); return;
      }
      if (attachment.insertion?.kind !== 'paste') { fail(t.terminal.paste.noCli); return; }
      // Use shared rules locally too, so updated quoting works with an older backend.
      const plan = planImageInsertion({ cli: attachment.insertion.cli, path: attachment.path });
      if (plan.kind !== 'paste') { fail(t.terminal.paste.pathUnavailable); return; }
      pending = { target, data: plan.data };
      if (plan.requiresConfirmation) options.state({ phase: 'confirm', message: t.terminal.paste.confirmInsert(plan.cli), preview });
      else insert();
    } catch (error) {
      if (controller !== request || disposed) return;
      fail(timedOut ? t.terminal.paste.timeout : error instanceof Error ? error.message : t.terminal.paste.uploadRetry);
    } finally { clearTimeout(timeout); if (controller === request) controller = null; }
  }
  return { paste, insert, cancel, invalidate, dispose() { cancel(); disposed = true; } };
}
