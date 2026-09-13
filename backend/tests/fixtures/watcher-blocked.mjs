process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message.type !== 'watch') return;
  const end = Date.now() + 5000;
  while (Date.now() < end) { /* Simulate FSEvents native cleanup. */ }
});
