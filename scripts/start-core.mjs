import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve(process.env.CORE_INSTALL_DIR??join(homedir(),'.roost','core'));
// Resolve the release once: changing current never rewrites a running process's files.
const entry=await realpath(join(root,'current','core.mjs'));
const origins = [...new Set([...(process.env.CORE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean), 'http://127.0.0.1:8789', 'http://localhost:8789'])].join(',');
const child=spawn(process.execPath,[entry],{stdio:'inherit',env:{...process.env,CORE_ALLOWED_ORIGINS:origins}});
process.once('SIGTERM',()=>child.kill('SIGTERM'));process.once('SIGINT',()=>child.kill('SIGINT'));
child.once('error',error=>{console.error(error);process.exitCode=1});
child.once('exit',code=>{process.exitCode=code??0});
