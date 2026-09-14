import { planImageInsertion } from '@roost/cli-adapters';
import { getAttachmentTarget, sendToSession, uploadSessionImage, type AttachmentTarget } from '../../features/terminal/public';
import { t } from '@roost/i18n';

const sameTarget = (a: AttachmentTarget, b: AttachmentTarget | null) => b !== null &&
  a.sessionId === b.sessionId && a.instanceId === b.instanceId && a.epoch === b.epoch;

export function moleculeReference(sourcePath: string, imageData: string) {
  if (!/^(?:\/|[a-z]:[\\/])/i.test(sourcePath) || /[\x00-\x1f\x7f-\x9f]/.test(sourcePath)) throw new Error(t.files.molecule.pathUnsupported);
  // 括号粘贴的控制码属于协议，不进 i18n；文案只负责中间那句话。
  return `\x1b[200~${t.files.molecule.reference(JSON.stringify(sourcePath))}\x1b[201~${imageData}`;
}

export async function handoffMolecule(sessionId: string, path: string, png: Blob, signal: AbortSignal,
  deps = { target: getAttachmentTarget, upload: uploadSessionImage, send: sendToSession }) {
  const target = deps.target(sessionId);
  if (!target) throw new Error(t.files.molecule.terminalNotReady);
  const attachment = await deps.upload(new File([png], 'molecule.png', { type: 'image/png' }), target, signal);
  if (signal.aborted || !sameTarget(target, deps.target(sessionId)) ||
      attachment.sessionId !== target.sessionId || attachment.instanceId !== target.instanceId) {
    throw new Error(t.files.molecule.connectionChanged);
  }
  const plan = planImageInsertion({ cli: attachment.insertion.kind === 'paste' ? attachment.insertion.cli : null, path: attachment.path });
  if (plan.kind !== 'paste') throw new Error(t.files.molecule.cliUnsupported);
  if (deps.send(sessionId, moleculeReference(path, plan.data)) !== 'sent') throw new Error(t.files.molecule.notDelivered);
}
