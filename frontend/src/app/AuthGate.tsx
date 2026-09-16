import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchAuthSession, login, type AuthSession } from "../shared/api/auth";
import { onSessionExpired } from "../shared/api/request";
import { ApiError } from "../shared/api/errors";
import { t } from "@roost/i18n";
import { desktopRuntime } from '../shared/runtime';

/**
 * 登录关卡。
 *
 * 两条原则：
 *
 * 1. **只有 `/api/auth/session` 是公开的。** `/api/health` 现在也要登录，
 *    拿它的 401 当「后端离线」会得出完全错误的结论——所以探测一律走 session。
 * 2. **不自己管理身份。** 身份在 HttpOnly Cookie 里，前端读不到。这里不存密码、
 *    不存 token，只反复问服务端「我现在算不算登录了」。
 *
 * 未登录时**不卸载**下面的应用，而是盖一层——这样会话到期时你没提交的输入
 * （终端里敲了一半的命令、写了一半的笔记）还在原地。
 */
type Phase = { kind: "checking" } | { kind: "error"; message: string } | { kind: "ready"; session: AuthSession };

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [expired, setExpired] = useState(false);

  const check = useCallback(async () => {
    try {
      setPhase({ kind: "ready", session: await fetchAuthSession() });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // 任何请求上回来的 401 都会走到这里。只标记「过期」，绝不自动清空任何输入。
  useEffect(() => onSessionExpired(() => {
    setExpired(true);
    setPhase(previous => previous.kind === "ready"
      ? { kind: "ready", session: { ...previous.session, authenticated: false } }
      : previous);
  }), []);

  const authenticated = phase.kind === "ready" && phase.session.authenticated;

  return (
    <>
      {/* 应用始终挂载：盖一层而不是卸载，未提交的内容才不会丢。 */}
      <div className={authenticated ? "contents" : "pointer-events-none select-none blur-sm"} aria-hidden={!authenticated}>
        {children}
      </div>
      {!authenticated && (
        <LoginOverlay
          phase={phase}
          expired={expired}
          onSignedIn={session => { setExpired(false); setPhase({ kind: "ready", session }); }}
          onRetry={() => { setPhase({ kind: "checking" }); void check(); }}
        />
      )}
    </>
  );
}

function LoginOverlay({ phase, expired, onSignedIn, onRetry }: {
  phase: Phase;
  expired: boolean;
  onSignedIn: (session: AuthSession) => void;
  onRetry: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement;
    // A z-index overlay cannot cover native settings dialogs in the top layer.
    // Open another modal so reauthentication works without discarding drafts.
    element.showModal();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { input.current?.focus(); }, [phase.kind]);

  const submit = useCallback(async () => {
    if (!password || busy) return;
    setBusy(true); setMessage(null);
    try {
      onSignedIn(await login(password));
      setPassword("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        // 后端限速。**不自动重试**——那只会把限速拖得更久。
        setMessage(t.misc.auth.rateLimited(60));
      } else if (error instanceof ApiError && error.status === 401) {
        setMessage(t.misc.auth.wrong);
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally { setBusy(false); }
  }, [password, busy, onSignedIn]);

  const unconfigured = phase.kind === "ready" && !phase.session.configured;

  return (
    <dialog ref={dialog} aria-modal="true" aria-label={desktopRuntime ? t.misc.auth.desktopTitle : t.misc.auth.title}
      onCancel={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()}
      className="fixed inset-0 z-[200] m-0 grid h-dvh max-h-none w-screen max-w-none place-items-center border-0 bg-bg/95 p-4 text-text backdrop:bg-transparent">
      <div className="flex w-[min(360px,92vw)] flex-col gap-3 rounded-xl border border-border bg-bg-panel p-5 shadow-modal">
        <div className="text-title font-semibold text-text">{desktopRuntime ? t.misc.auth.desktopTitle : t.misc.auth.title}</div>

        {phase.kind === "checking" && <div className="text-caption text-text-dim">{desktopRuntime ? t.misc.auth.desktopConnecting : t.misc.auth.checking}</div>}

        {desktopRuntime && phase.kind === 'ready' && <>
          <p className="text-caption text-text-dim">{t.misc.auth.desktopUnavailable}</p>
          <button type="button" onClick={onRetry} className="rounded-md bg-bg-active px-3 py-2 text-body text-text">{t.misc.conversations.retry}</button>
        </>}

        {phase.kind === "error" && (
          <>
            <div role="alert" className="text-caption text-danger">{t.misc.auth.offline}</div>
            <button type="button" className="rounded-md bg-bg-active px-3 py-2 text-body text-text hover:bg-bg-hover" onClick={onRetry}>
              {t.misc.conversations.retry}
            </button>
          </>
        )}

        {/* configured=false 是部署问题，不是密码错——给密码框只会让人白试。 */}
        {!desktopRuntime && unconfigured && (
          <div role="alert" className="flex flex-col gap-1">
            <div className="text-body text-danger">{t.misc.auth.unconfigured}</div>
            <div className="text-caption text-text-dim">{t.misc.auth.unconfiguredHint}</div>
          </div>
        )}

        {!desktopRuntime && phase.kind === "ready" && phase.session.configured && (
          <>
            {expired && (
              <div role="status" className="flex flex-col gap-0.5">
                <div className="text-caption text-warning">{t.misc.auth.expired}</div>
                <div className="text-caption text-text-dim">{t.misc.auth.expiredHint}</div>
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-caption text-text-dim">{t.misc.auth.password}</span>
              <input
                ref={input}
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={event => setPassword(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
                className="h-9 rounded-md border border-border bg-bg px-2 text-body text-text outline-none focus:border-accent"
              />
            </label>
            {message && <div role="alert" className="text-caption text-danger">{message}</div>}
            <button type="button" disabled={busy || !password}
              className="rounded-md bg-bg-active px-3 py-2 text-body text-text hover:bg-bg-hover disabled:opacity-40"
              onClick={() => void submit()}>
              {busy ? t.misc.auth.submitting : t.misc.auth.submit}
            </button>
            {/* 密码只在本机文件里，服务端不提供任何获取接口——这里只能告诉你去哪找。 */}
            <div className="text-caption text-text-dim/80">{t.misc.auth.hint}</div>
          </>
        )}
      </div>
    </dialog>
  );
}
