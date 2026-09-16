import { useCallback, useEffect, useState } from "react";
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
 * 用户既不知道起了什么也不知道端口。
 *
 * **做成右栏的一个视图，不是浮层。** 第一版是浮在工具栏下的弹窗，有两个毛病：它挂在面板
 * 标题栏里，而标题栏不在下面那个 `relative` 容器内，手写 `absolute` 会去贴一个没指定的
 * 祖先；而且它遮住终端内容，看端口的同时看不到日志。右栏本来就是可停靠、可常开的地方。
 *
 * **按需取，不轮询**：后端一次 ps + lsof 实测 41ms。切到这个视图、换终端、点刷新时各取
 * 一次；常驻轮询会在进程多的机器上变味，而这本来就是「想看的时候看一眼」。
 */
export function TerminalProcesses({ sessionId, active }: { sessionId: string | null; active?: boolean }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true); setError(null);
    try { setAnswer(await request<Answer>(`/api/sessions/${encodeURIComponent(id)}/processes`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, []);

  // 换终端要重取，而且先把上一条的答案清掉——否则会把别的终端的进程显示成这一条的。
  useEffect(() => {
    setAnswer(null); setError(null);
    if (!sessionId || active === false) return;
    void load(sessionId);
  }, [sessionId, active, load]);

  if (!sessionId) return <Empty text={t.terminal.processes.noSession} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5 text-caption text-text-dim">
        <span className="min-w-0 flex-1 truncate">
          {answer?.supported === true ? answer.tty : ""}
        </span>
        <button type="button" className="shrink-0 rounded px-2 py-0.5 hover:bg-bg-hover hover:text-text"
          disabled={loading} onClick={() => void load(sessionId)}>
          {loading ? t.terminal.processes.loading : t.terminal.processes.refresh}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error && <p role="alert" className="px-1 py-2 text-caption text-danger">{error}</p>}
        {!error && loading && !answer && <p className="px-1 py-2 text-caption text-text-dim">{t.terminal.processes.loading}</p>}
        {/* 不支持和「什么都没跑」是两件事，分开说。 */}
        {answer?.supported === false && <Empty text={t.terminal.processes.unsupported} />}
        {answer?.supported === true && answer.services.length === 0 && <Empty text={t.terminal.processes.empty} />}
        {answer?.supported === true && answer.services.length > 0 && (
          <ul className="flex flex-col gap-1">
            {answer.services.map(service => <Row key={service.pid} service={service} />)}
          </ul>
        )}
      </div>
      {answer?.supported === true && (
        <p className="shrink-0 border-t border-border px-2.5 py-1.5 text-caption text-text-dim/70">
          {t.terminal.processes.hint}
        </p>
      )}
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-1 py-3 text-caption text-text-dim">{text}</p>;

/**
 * 一行一个进程。完整命令行默认收起来——一个 python 就能占三行，而用户扫这个列表是为了
 * 找端口，不是读路径。展开是个 `<details>`，不引入新的状态。
 */
function Row({ service }: { service: TerminalProcess }) {
  // 命令行的首个 token 常常是一长串绝对路径；取它的最后一段，再带上后面两个参数。
  // **本来就短的命令整条显示、不给展开**——`caffeinate -i -t 300` 折起来只藏了一个 `300`，
  // 那一行「完整命令」是纯噪音。阈值按右栏最窄时一行放得下来定。
  const words = service.command.split(/\s+/);
  const brief = [words[0]?.split("/").at(-1) ?? "", ...words.slice(1, 3)].join(" ").trim();
  const inline = service.command.length <= 48;
  const short = inline ? service.command : brief;
  return (
    <li className="rounded border border-border/60 px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-caption tabular-nums text-text-dim">{service.pid}</span>
        {service.listening.map(address => <Address key={address} address={address} />)}
        <span className="min-w-0 flex-1 truncate text-caption text-text">{short}</span>
      </div>
      {short !== service.command && (
        <details className="mt-0.5">
          <summary className="cursor-pointer list-none text-caption text-text-dim/70 hover:text-text-dim">
            {t.terminal.processes.full}
          </summary>
          <code className="mt-1 block break-all text-caption text-text-dim/90">{service.command}</code>
        </details>
      )}
    </li>
  );
}

/**
 * 监听地址。能拼出可点的 http 链接就给链接——那是用户点开这个视图最想要的东西。
 *
 * `*` 和 `[::]` 表示所有网卡；从浏览器过去要用一个具体地址，用 localhost 是唯一
 * **不会猜错**的选择（这个视图本来就只描述本机的进程）。
 */
function Address({ address }: { address: string }) {
  const port = /:(\d{1,5})$/.exec(address)?.[1];
  const host = port ? address.slice(0, -(port.length + 1)) : "";
  const reachable = port && (host === "*" || host === "[::]" || host === "0.0.0.0"
    || host === "127.0.0.1" || host === "[::1]" || host === "localhost");
  const cls = "shrink-0 rounded bg-bg-active px-1.5 font-mono text-caption";
  if (!reachable) return <span className={`${cls} text-text`}>{address}</span>;
  return <a href={`http://localhost:${port}`} target="_blank" rel="noreferrer"
    className={`${cls} text-accent hover:underline`}>{address}</a>;
}
