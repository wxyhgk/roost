import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServerMonitorProcess, normalizeServiceNames, type ServerMonitor } from '@roost/server-monitor';
import { listeningServices, listeningSockets, listenScope, normalizeTty, probeHttp, processTable, shortCommand, terminalEnvOwners } from '@roost/terminal-runtime';
import type { TerminalService } from '@roost/terminal-runtime';
import type { WorkspaceStore } from '@roost/workspace-store';
import { readJson, sendError, HttpInputError } from './http';

/**
 * `/api/server/*` 全在这儿。
 *
 * **端口那条原来落在 `server.ts` 里**，于是「服务器状态」这一块的后端被劈成了两处：
 * 三条走这个文件、一条走那个一千多行的总路由表。同一块功能分散在两个地方，下次改的人
 * 只会找到一半。
 *
 * 它需要 `runtime`/`store`（要拿各条 PTY 的 ptsName 把端口归属回终端），所以这个工厂
 * 多收一个可选的 `terminals`——给不了就不注册那条路由，而不是注册一条会报错的。
 */
export function createServerMonitorHandler(dataDir?: string, monitor: ServerMonitor = createServerMonitorProcess(),
  terminals?: { runtime: TerminalService; store: WorkspaceStore }) {
  const path = dataDir ? join(dataDir, 'monitored-services.json') : null;
  let loading: Promise<void> | undefined, writes = Promise.resolve();
  const load = () => loading ??= (async () => {
    if (!path) return;
    try { monitor.configure(normalizeServiceNames(JSON.parse(await readFile(path, 'utf8')))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  })();
  const json = (res: ServerResponse, data: unknown) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      const routes = ['/api/server/status', '/api/server/summary', '/api/server/services',
        ...(terminals ? ['/api/server/ports'] : [])];
      if (!routes.includes(url.pathname)) return false;
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/api/server/summary' && req.method === 'GET') {
        try { json(res, await monitor.summary()); }
        catch { sendError(res, 503, 'source_unavailable', 'Server metrics are temporarily unavailable'); }
        return true;
      }
      if (url.pathname === '/api/server/status' && req.method === 'GET') {
        try { await load(); json(res, await monitor.snapshot()); }
        catch { sendError(res, 503, 'source_unavailable', 'Server metrics are temporarily unavailable'); }
        return true;
      }
      if (url.pathname === '/api/server/ports' && req.method === 'GET' && terminals) {
        /*
          整机在监听的端口 → 各是谁。**按需调用，不做常驻轮询**：它要 fork 一次 lsof，
          本机约 28ms，点开面板时问一次绰绰有余；挂成每秒一次，进程多的机器上会变味。

          `supported:false` 和「一个都没有」严格分开——lsof 没装、被策略挡住、超时都属于
          前者，而把「看不到」画成「什么都没跑」是在撒谎。
        */
        const [rows, probe] = await Promise.all([processTable(), listeningSockets()]);
        if (!probe.supported) { json(res, { supported: false, services: [] }); return true; }
        /*
          **归属回 roost 的终端。** 「8080 是谁占着」之后紧接着的问题是「那玩意是我在哪儿起的」。

          第一版只比 tty，而实测本机 19 个监听端点里 tty 一个都没有——想认出来的恰好是那些
          已经脱离终端的常驻服务。判据换成会话注入的环境变量之后同一批认出 10 个，tty 退为
          退路。优先级写在 `listeningServices` 里，两个调用方（这里和 CLI）共用同一份。

          环境变量要 fork 一次 ps（macOS），所以只查真的在监听的那些 pid，不是整张进程表。
        */
        const envOwners = await terminalEnvOwners(probe.rows.map(row => row.pid));
        const ttyOwners = new Map<string, string>();
        for (const session of terminals.store.loadWorkspace().sessions) {
          const tty = normalizeTty(terminals.runtime.getSession(session.id)?.ptsName);
          if (tty) ttyOwners.set(tty, session.id);
        }
        const services = listeningServices({ rows, listeners: probe.rows, envOwners, ttyOwners });
        /*
          `?probe=1`：再花一次往返问问每个端口上说的是不是 HTTP。

          **只有启动台要这一格**，面板不要——它得知道哪些点得开，否则会把 postgres 也画成
          「应用」，点进去只有一张错误页，而人会以为是 roost 坏了。按查询参数开，是因为
          这要给每个端口开一条连接（本机 7 个端口实测 122ms），不该让只想看端口列表的人也付。
        */
        const wantProbe = url.searchParams.get('probe') === '1';
        const httpPorts = wantProbe
          ? new Set((await Promise.all([...new Set(services.map(s => s.port))]
              .filter((port): port is number => port !== null)
              .map(async port => await probeHttp(port) === 'http' ? port : null))).filter(port => port !== null))
          : null;
        json(res, { supported: true, services: services.map(service => ({
          ...service,
          // 命令行可能夹带密钥，截断是有界性不是脱敏；父进程同理。
          command: service.command?.slice(0, 512) ?? null,
          parent: service.parent?.slice(0, 256) ?? null,
          /*
            列表那一行显示的短名。**在这一侧算**：`shortCommand` 住在 terminal-runtime，
            而那个包不在 `allowed.frontend` 里（它连着 node-pty）。复制一份到前端就会有
            两份实现各自漂移，所以算好了传过去，完整命令另外一格照旧。
          */
          label: shortCommand(service.command),
          /* 谁够得着这个端口。理由见 `listenScope`；和 label 一样在这一侧算好。 */
          scope: listenScope(service.address),
          /** 这个端口上说的是不是 HTTP。没要求探测时是 null——**不是 false**，两者意思不一样。 */
          http: httpPorts ? service.port !== null && httpPorts.has(service.port) : null,
        })) });
        return true;
      }
      if (url.pathname === '/api/server/services' && req.method === 'PUT') {
        const body = await readJson(req, 8192);
        let units: string[];
        try { units = normalizeServiceNames(body.services); } catch { throw new HttpInputError(400, 'Use up to 24 valid service names'); }
        const save = writes.catch(() => {}).then(async () => {
          await load();
          if (path && dataDir) {
            await mkdir(dataDir, { recursive: true, mode: 0o700 });
            const temporary = path + '.' + randomUUID();
            try { await writeFile(temporary, JSON.stringify(units) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
            finally { await rm(temporary, { force: true }); }
          }
          monitor.configure(units);
        });
        writes = save;
        try { await save; json(res, { services: units }); }
        catch { sendError(res, 503, 'storage_unavailable', 'Could not save monitored services'); }
        return true;
      }
      res.setHeader('allow', url.pathname.endsWith('/services') ? 'PUT' : 'GET');
      sendError(res, 405, 'method_not_allowed', 'Method not allowed');
      return true;
    },
    dispose() { monitor.dispose(); },
  };
}
