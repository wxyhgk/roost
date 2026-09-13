import { existsSync } from 'node:fs';
const source = existsSync(new URL('./index.js', import.meta.url))
  ? import('./index.js')
  : import('tsx/esm/api').then(({ tsImport }) => tsImport('./index.ts', import.meta.url));
const ready = source.then(({ createServerMonitor }) => createServerMonitor());
const reply = message => { if (process.connected) process.send(message, () => {}); };
// Register before loading TypeScript so early configuration cannot be lost.
process.on('message', message => {
  void ready.then(monitor => {
    if (message.type === 'configure') { monitor.configure(message.units); return; }
    if (message.type === 'snapshot' || message.type === 'summary') return monitor[message.type]().then(snapshot => reply({ id: message.id, snapshot }));
  }).catch(() => reply({ id: message.id, error: true }));
});
process.on('disconnect', () => { process.exit(0); });
