import { useState } from "react";
import { ServerStackIcon } from "@heroicons/react/24/outline";
import { IconButton } from "../../../shared/ui/IconButton";
import { request } from "../../../shared/api/request";
import { t } from "@roost/i18n";

type TerminalProcess = { pid: number; command: string; listening: string[] };
type Answer =
  | { supported: true; tty: string; services: TerminalProcess[] }
  | { supported: false; reason: string };

/**
 * 「这个终端里在跑什么、监听哪个端口」。
 *
 * AI 常常起一些后台服务（`npm run dev &`、`python -m http.server &`），那次工具调用一返回，
 * 用户既不知道起了什么也不知道端口。这个按钮按需回答它。
 *
 * **按需取，不轮询**：后端一次 ps + lsof 实测 41ms，点一下绰绰有余；常驻会在进程多的机器上
 * 变味，而这本来就是「想看的时候看一眼」。
 *
 * **拿不到控制终端时明说不支持**，不画空列表——空列表的意思是「什么都没跑」，那是另一回事。
 */
export function TerminalProcesses({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try { setAnswer(await request<Answer>(`/api/sessions/${encodeURIComponent(sessionId)}/processes`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }

  return (
    <>
      <IconButton title={t.terminal.processes.title}
        onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>
        <ServerStackIcon className="size-4" />
      </IconButton>
      {open && (
        <div className="absolute right-2 top-10 z-20 max-h-[60vh] w-[min(34rem,calc(100vw-2rem))] overflow-auto
          rounded-lg border border-border bg-bg-raised p-2 shadow-pop">
          <div className="flex items-center gap-2 pb-1.5 text-caption text-text-dim">
            <span className="min-w-0 flex-1 truncate">{t.terminal.processes.title}</span>
            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-hover"
              disabled={loading} onClick={() => void load()}>{t.terminal.processes.refresh}</button>
          </div>
          {error && <p role="alert" className="px-1 py-2 text-caption text-danger">{error}</p>}
          {!error && loading && !answer && <p className="px-1 py-2 text-caption text-text-dim">{t.terminal.processes.loading}</p>}
          {/* 不支持和「什么都没跑」是两件事，分开说。 */}
          {answer?.supported === false && (
            <p className="px-1 py-2 text-caption text-text-dim">{t.terminal.processes.unsupported}</p>
          )}
          {answer?.supported === true && answer.services.length === 0 && (
            <p className="px-1 py-2 text-caption text-text-dim">{t.terminal.processes.empty}</p>
          )}
          {answer?.supported === true && answer.services.length > 0 && (
            <ul className="flex flex-col gap-1">
              {answer.services.map(service => (
                <li key={service.pid} className="flex flex-col gap-0.5 rounded border border-border/60 px-2 py-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-caption tabular-nums text-text-dim">{service.pid}</span>
                    {service.listening.map(address => <Address key={address} address={address} />)}
                  </div>
                  <code className="break-all text-caption text-text-dim/90">{service.command}</code>
                </li>
              ))}
            </ul>
          )}
          {answer?.supported === true && (
            <p className="px-1 pt-1.5 text-caption text-text-dim/70">{t.terminal.processes.hint}</p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * 监听地址。能拼出可点的 http 链接就给链接——那是用户点开这个面板最想要的东西。
 *
 * `*` 和 `[::]` 表示所有网卡；从浏览器过去要用一个具体地址，用 localhost 是唯一
 * **不会猜错**的选择（这个面板本来就只描述本机的进程）。
 */
function Address({ address }: { address: string }) {
  const port = /:(\d{1,5})$/.exec(address)?.[1];
  const host = port ? address.slice(0, -(port.length + 1)) : "";
  const reachable = port && (host === "*" || host === "[::]" || host === "0.0.0.0"
    || host === "127.0.0.1" || host === "[::1]" || host === "localhost");
  const label = <span className="shrink-0 rounded bg-bg-active px-1.5 font-mono text-caption text-text">{address}</span>;
  if (!reachable) return label;
  return <a href={`http://localhost:${port}`} target="_blank" rel="noreferrer"
    className="shrink-0 rounded bg-bg-active px-1.5 font-mono text-caption text-accent hover:underline">{address}</a>;
}
