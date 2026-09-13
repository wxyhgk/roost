// Standalone helper copied to the application's persistent data directory.
// Keep only quota fields; never persist the complete statusLine input.
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
let length = 0; const chunks = [];
for await (const chunk of process.stdin) { length += chunk.length; if (length > 1048576) process.exit(0); chunks.push(chunk); }
const input = Buffer.concat(chunks).toString('utf8');
try {
  const data = JSON.parse(input);
  if (typeof data.session_id === 'string' && data.session_id.length <= 512) {
    const directory = join(root, 'claude-captures'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const sessionRef = hash(data.session_id), path = join(directory, sessionRef + '.json'), rates = {};
    for (const key of ['five_hour', 'seven_day', 'spend_limit']) {
      const row = data.rate_limits?.[key];
      if (row && Number.isFinite(row.used_percentage) && row.used_percentage >= 0 && row.used_percentage <= 1e6) {
        rates[key] = { used_percentage: row.used_percentage, resets_at: Number.isFinite(row.resets_at) ? row.resets_at : null };
      }
    }
    const mark = hash(JSON.stringify([rates, data.cost?.total_cost_usd, data.context_window?.total_input_tokens, data.context_window?.total_output_tokens]));
    let previous; try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* First sample. */ }
    const now = new Date().toISOString();
    const sample = { sessionRef, rates, receivedAt: now, observedAt: Object.keys(rates).length ? previous?.mark === mark ? previous.observedAt : now : null, mark };
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(sample), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
    const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (files.length > 32) {
      const rows = await Promise.all(files.map(async name => ({ name, time: await stat(join(directory, name)).then(s => s.mtimeMs, () => 0) })));
      for (const row of rows.sort((a, b) => b.time - a.time).slice(32)) await unlink(join(directory, row.name)).catch(() => {});
    }
  }
} catch { /* Quota collection must never interrupt the user's status line. */ }
try {
  const metadata = JSON.parse(await readFile(join(root, 'claude-statusline-config.json'), 'utf8'));
  const command = metadata.original?.command;
  if (typeof command === 'string' && command) {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => {}); child.stdin.on('error', () => {}); child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000); timer.unref();
    child.on('close', code => { clearTimeout(timer); process.exitCode = code ?? 0; });
    process.once('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
  }
} catch { /* No previous command. */ }
