import { createInterface } from 'node:readline';
const mode = process.env.ROOST_TEST_RPC_MODE;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (mode === 'blocked') return;
  if (!['initialize','initialized','account/read','account/rateLimits/read'].includes(m.method)) process.exit(2);
  if (m.id == null) return;
  let result = {};
  if (m.method === 'account/read') result = { account: { type: 'chatgpt', email: mode === 'changed' && m.id === 4 ? 'new@example.invalid' : 'test@example.invalid', planType: 'plus', accessToken: 'must-never-leak' } };
  if (m.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1900000000 } } };
  if (mode === 'unsupported') process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'private token must-never-leak' } })+'\n');
  else process.stdout.write(JSON.stringify({ id: m.id, result })+'\n');
});
