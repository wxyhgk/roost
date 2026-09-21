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
  /**
   * 收下一张图：校验、上传、按当前 CLI 的规矩插进去。
   *
   * 粘贴和拖放走的是**同一条路**——从这里往下，两者没有任何区别。上面那一层只负责把
   * 各自的事件拆成「有几个候选、第一个是什么」，因为剪贴板给的是 `DataTransferItem`、
   * 拖放给的是 `File`，形状不同而已。
   *
   * @param count 候选有几个。**必须由调用方数**：一次只收一张，而「你拖了三张」和
   *   「这一张格式不对」要给出不同的说法。
   */
  async function accept(file: File | null, count: number) {
    if (controller || pending) return; // Preserve the visible in-progress attachment.
    revoke();
    const fail = (message: string) => options.state({ phase: 'error', message, preview });
    if (count !== 1) { fail(t.terminal.paste.oneAtATime); return; }
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

  async function paste(event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault' | 'stopImmediatePropagation'>) {
    const items = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!items.length || disposed) return;
    event.preventDefault(); event.stopImmediatePropagation();
    await accept(items[0].getAsFile(), items.length);
  }

  /**
   * 从系统里拖一张图进来。和粘贴完全同义。
   *
   * 截图工具、聊天软件里更自然的动作是拖而不是复制，而这条路以前什么都不做——
   * 上传和插入的两半零件其实一直都在，只差这个入口。
   *
   * **不碰应用内部的拖放**：文件树往终端拖路径走的是另一条（`ROOST_PATH_MIME`），
   * 那种拖放的 `files` 是空的，这里自然就不接。
   */
  async function drop(transfer: Pick<DataTransfer, 'files'> | null) {
    const images = [...(transfer?.files ?? [])].filter(file => file.type.startsWith('image/'));
    if (!images.length || disposed) return false;
    await accept(images[0], images.length);
    return true;
  }

  return { paste, drop, insert, cancel, invalidate, dispose() { cancel(); disposed = true; } };
}
