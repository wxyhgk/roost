import { createRoot } from 'react-dom/client';
import { Editor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone/dist/binaryWasm';
import 'ketcher-react/dist/index.css';
import { ErrorBoundary } from '../../shared/ui/ErrorBoundary';
import { moleculeChannel, type MoleculeFormat, type MoleculeWindow } from './bridge';
import './frame.css';
import { t } from '@roost/i18n';

const notify = (type: string, message?: string) => parent.postMessage({ channel: moleculeChannel, type, message }, location.origin);
const provider = new StandaloneStructServiceProvider();
let loading = false;
let format: MoleculeFormat = 'mol';
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); event.stopImmediatePropagation(); notify('save');
  }
}, true);
window.addEventListener('error', event => notify('error', event.message));
window.addEventListener('unhandledrejection', event => notify('error', String(event.reason)));
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary region={t.files.molecule.region}>
    <Editor staticResourcesUrl="/" structServiceProvider={provider} disableMacromoleculesEditor
      errorHandler={message => notify('error', message)}
      onInit={ketcher => {
        (window as MoleculeWindow).moleculeEditor = {
          async load(content, next) {
            format = next;
            loading = true;
            try { if (content.trim()) await ketcher.setMolecule(content); }
            finally { loading = false; }
          },
          save() {
            return format === 'sdf' ? ketcher.getSdf() : ketcher.getMolfile('v2000');
          },
          molfile: () => ketcher.getMolfile('v2000'),
          png: content => ketcher.generateImage(content, { outputFormat: 'png' }),
        };
        ketcher.editor.subscribe('change', () => { if (!loading) notify('change'); });
        notify('ready');
      }} />
  </ErrorBoundary>,
);
