import { targets } from './lib/targets.mjs';
for (const [triple, target] of Object.entries(targets)) {
  console.log(`${triple.padEnd(31)} ${target.status}`);
  if (target.reason) console.log(`  ${target.reason}`);
}
