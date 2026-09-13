import { tsImport } from 'tsx/esm/api';
const ready = tsImport('./index.ts', import.meta.url).then(({ createServerMonitor }) => createServerMonitor());
const reply = message => { if (process.connected) process.send(message, () => {}); };
// Register before loading TypeScript so early configuration cannot be lost.
process.on('message', message => {
  void ready.then(monitor => {
    if (message.type === 'configure') { monitor.configure(message.units); return; }
    if (message.type === 'snapshot' || message.type === 'summary') return monitor[message.type]().then(snapshot => reply({ id: message.id, snapshot }));
  }).catch(() => reply({ id: message.id, error: true }));
});
process.on('disconnect', () => { process.exit(0); });
