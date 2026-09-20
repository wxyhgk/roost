import { t } from '@roost/i18n';
import { useResumePlan } from '../useResumePlan';
import { resumeReason, PERMANENT_RESUME_REASONS } from '../resumeMessages';

export function TerminalRecovery({ sessionId, restarting, restartError, revision, restart }: {
  sessionId: string; restarting: boolean; restartError: string | null; revision: number;
  restart(resume?: boolean): void;
}) {
  const query = useResumePlan(sessionId, !restarting, revision);
  const plan = query.plan?.available ? query.plan : null;
  const message = query.failed ? t.terminal.recovery.failed
    : query.plan && !query.plan.available ? resumeReason(query.plan.reason)
    : query.loading ? t.terminal.recovery.checking : null;
  return (
    <div className="term-status-exited absolute top-2 left-1/2 z-[6] -translate-x-1/2 flex w-max max-w-[calc(100%-24px)] flex-wrap items-center gap-2 rounded-lg bg-bg-raised/80 border border-border/60 px-3 py-1.5 text-caption text-text-dim pointer-events-auto backdrop-blur-md shadow-[0_2px_12px_rgba(0,0,0,0.3)]"
      onMouseUp={event => event.stopPropagation()}>
      <span>{t.terminal.view.exited}</span>
      {/* 这个按钮会**先重启这个终端**，按钮上那四个字看不出来，所以补一句 title。 */}
      {!restarting && plan && <button type="button" title={t.terminal.view.resumeHint(plan.command.join(' '))}
        onClick={() => restart(true)}>{t.terminal.view.resume(plan.cliName)}</button>}
      <button type="button" disabled={restarting} onClick={() => restart(false)}>
        {restarting ? t.terminal.view.restarting : t.terminal.view.restart}
      </button>
      {!restarting && message && message !== restartError && <span role="status" className="basis-full">
        {message}{query.retrying && ` ${t.terminal.recovery.autoRetry}`}
      </span>}
      {/*
        「此 CLI 不支持恢复」这类是**永久**结论，再查一百次也是同一句话。原来这里只判
        `!plan`，于是那句话旁边永远挂着一个「重新检查」，点几次都没反应。
      */}
      {!restarting && !plan && !(query.plan && !query.plan.available && PERMANENT_RESUME_REASONS.has(query.plan.reason)) && (
        <button type="button" disabled={query.loading} onClick={query.refresh}>
          {t.terminal.recovery.retry}
        </button>
      )}
      {restartError && <span role="alert" className="basis-full">{restartError}</span>}
    </div>
  );
}
