// Ketcher's browser dependencies use process.nextTick; scope the browser shim
// to this iframe, never the terminal workbench.
// @ts-expect-error process/browser ships JavaScript without declarations.
import browserProcess from 'process/browser';
import { moleculeChannel } from './bridge';
import { t } from '@roost/i18n';
Object.assign(globalThis, { process: browserProcess, global: globalThis });
void import('./frame').catch(error => {
  const message = t.files.molecule.bootstrapFailed(error instanceof Error ? error.message : String(error));
  document.getElementById('root')!.textContent = message;
  parent.postMessage({ channel: moleculeChannel, type: 'error', message }, location.origin);
});
