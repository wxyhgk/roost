import { tsImport } from 'tsx/esm/api';
const ready = tsImport('./watcher.ts', import.meta.url).then(({ createFileWatcher }) => createFileWatcher());
const subscriptions = new Map();
const send = message => { if (process.connected) process.send(message, () => {}); };
process.on('message', message => {
  void ready.then(watcher => {
    if (message.type === 'watch') {
      const stop = watcher.watch(message.root, () => send({ type: 'change', id: message.id }), () => { subscriptions.delete(message.id); send({ type: 'error', id: message.id }); });
      subscriptions.set(message.id, stop);
    } else if (message.type === 'unwatch') { subscriptions.get(message.id)?.(); subscriptions.delete(message.id); }
  }).catch(() => send({ type: 'error', id: message.id }));
});
setInterval(() => { void ready.then(watcher => send({ type: 'heartbeat', directories: watcher.directoryCount })).catch(() => process.exit(1)); }, 1000).unref();
process.on('disconnect', () => process.exit(0));
