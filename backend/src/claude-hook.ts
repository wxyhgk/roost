import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';

/** Explicitly provisioned per-terminal hooks. No global Claude settings are changed. */
export function createClaudeHookReceiver(options: {
  resolveInstance: (terminalId: string) => string | undefined;
  onSession: (event: { terminalId: string; instanceId: string; nativeSessionId: string; transcriptPath: string; event: string }) => void | Promise<void>;
}) {
  const registrations = new Map<string, { token: string; instanceId: string }>();
  return {
    register(terminalId: string, instanceId: string) {
      if (options.resolveInstance(terminalId) !== instanceId) throw new Error('instance_mismatch');
      const token = randomBytes(32).toString('hex'); registrations.set(terminalId, { token, instanceId }); return token;
    },
    revoke(terminalId: string) { registrations.delete(terminalId); },
    async handle(req: IncomingMessage, res: ServerResponse, terminalId: string) {
      const done = (status: number) => { res.writeHead(status); res.end(); };
      if (req.method !== 'POST') { done(405); return; }
      const registration = registrations.get(terminalId);
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!registration || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(registration.token))) { done(403); return; }
      if (options.resolveInstance(terminalId) !== registration.instanceId) { done(409); return; }
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) { done(413); return; } chunks.push(bytes); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(body.session_id) || typeof body.transcript_path !== 'string' || body.transcript_path.length > 4096 || !isAbsolute(body.transcript_path) || !['SessionStart','UserPromptSubmit','Stop'].includes(body.hook_event_name)) { done(400); return; }
        // Registration replacement/restart during body receipt must not adopt stale identity.
        if (registrations.get(terminalId) !== registration || options.resolveInstance(terminalId) !== registration.instanceId) { done(409); return; }
        await options.onSession({terminalId,instanceId:registration.instanceId,nativeSessionId:body.session_id,transcriptPath:body.transcript_path,event:body.hook_event_name});
        done(204);
      } catch { if (!res.headersSent) done(400); }
    },
    dispose() { registrations.clear(); },
  };
}

/** Caller writes these files into a private temporary plugin directory and starts
 * claude --plugin-dir DIR. Tokens are scoped/revocable and are never logged.
 * The observation hook fails open and never sends a Claude control decision. */
export function claudeHookPluginFiles(endpoint: string, token: string): Record<string, string> {
  const url = new URL(endpoint);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('invalid_hook_endpoint');
  const script = `const chunks=[];let size=0;try{for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)process.exit(0);chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json',Authorization:${JSON.stringify('Bearer '+token)}},body:JSON.stringify({session_id:input.session_id,transcript_path:input.transcript_path,hook_event_name:input.hook_event_name}),signal:AbortSignal.timeout(1500)});}catch{}\n`;
  const hook = {type:'command',command:'node "${CLAUDE_PLUGIN_ROOT}/observe.mjs"',timeout:2};
  return {'.claude-plugin/plugin.json':JSON.stringify({name:'roost-readonly-observer',version:'0.0.1'}), 'observe.mjs':script, 'hooks/hooks.json':JSON.stringify({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','Stop'].map(name=>[name,[{hooks:[hook]}]]))})};
}
