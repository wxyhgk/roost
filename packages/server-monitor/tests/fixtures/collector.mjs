let units = [], reads = 0;
process.on('disconnect', () => process.exit(0));
process.on('message', m => {
 if(m.type === 'configure') {units=m.units;return;}
 if(m.type !== 'snapshot' && m.type !== 'summary') return;
 if(units.includes('crash.service')) process.exit(1);
 const end=Date.now()+(units.includes('slow.service') ? 300 : 20);
 while(Date.now()<end) { /* Simulate a synchronous platform collector. */ }
 const snapshot = {configuredServices:units,reads:++reads,kind:m.type};
 setTimeout(() => process.send({id:m.id,snapshot}), units.includes('delayed.service') ? 100 : 0);
});
