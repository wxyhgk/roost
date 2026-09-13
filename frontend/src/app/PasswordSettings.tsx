import { useEffect, useRef, useState } from 'react';
import { CheckIcon, EyeIcon, EyeSlashIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { t } from '@roost/i18n';
import { changePassword, fetchAuthSession } from '../shared/api/auth';
import { ApiError } from '../shared/api/errors';

export function PasswordSettings({ onBusyChange }: { onBusyChange(busy: boolean): void }) {
  const [available, setAvailable] = useState<boolean | null>(null), [loadFailed, setLoadFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const mutation = useRef<AbortController | null>(null), m = t.settings.security;
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    setAvailable(null); setLoadFailed(false);
    void fetchAuthSession(controller.signal).then(value => { if (!controller.signal.aborted) setAvailable(value.canChangePassword === true); })
      .catch(() => { if (mounted) setLoadFailed(true); }).finally(() => clearTimeout(timer));
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  useEffect(() => () => { mutation.current?.abort(); mutation.current = null; onBusyChange(false); }, [onBusyChange]);
  async function submit() {
    if (mutation.current || !available) return;
    setSaved(false); setError(null);
    if (!current || !next || !confirm) { setError(m.required); return; }
    if (Array.from(next).length < 6 || next.length > 1024 || /[\r\n\0]/.test(next)) { setError(m.length); return; }
    if (next !== confirm) { setError(m.mismatch); return; }
    if (current === next) { setError(m.unchanged); return; }
    const controller = new AbortController(); mutation.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    setBusy(true); onBusyChange(true);
    try {
      const session = await changePassword(current, next, controller.signal);
      if (mutation.current !== controller) return;
      setCurrent(''); setNext(''); setConfirm(''); setVisible(false);
      setSaved(session.authenticated);
    } catch (failure) {
      if (mutation.current !== controller) return;
      const code = failure instanceof ApiError ? failure.code : null;
      setError(code === 'invalid_current_password' ? m.wrong : code === 'invalid_new_password' ? m.length : code === 'password_unchanged' ? m.unchanged
        : code === 'rate_limited' ? m.rateLimited : code === 'password_change_in_progress' ? m.inProgress : code === 'password_change_unavailable' ? m.unavailable
        : failure instanceof ApiError ? m.failed : m.uncertain);
    } finally { clearTimeout(timer); if (mutation.current === controller) { mutation.current = null; setBusy(false); onBusyChange(false); } }
  }
  if (loadFailed) return <div className="space-y-3 text-sm"><p role="alert">{m.loadFailed}</p><button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-md border border-border px-3 py-2">{m.retry}</button></div>;
  if (available === null) return <p role="status" className="text-sm text-text-dim">{m.loading}</p>;
  if (!available) return <p role="status" className="text-sm text-text-dim">{m.unavailable}</p>;
  const control = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';
  const fields = [
    { label: m.current, value: current, update: setCurrent, autoComplete: 'current-password', maxLength: 4096 },
    { label: m.next, value: next, update: setNext, autoComplete: 'new-password', maxLength: 1024 },
    { label: m.confirm, value: confirm, update: setConfirm, autoComplete: 'new-password', maxLength: 1024 },
  ];
  return <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} className="max-w-md space-y-4" aria-label={m.title}>
    <p className="text-sm leading-relaxed text-text-dim">{m.hint}</p>
    {fields.map(({ label, value, update, autoComplete, maxLength }) =>
      <label key={label} className="flex flex-col gap-2 text-sm"><span>{label}</span><input type={visible ? 'text' : 'password'} value={value} required disabled={busy}
        autoComplete={autoComplete} maxLength={maxLength} spellCheck={false} autoCapitalize="none" className={control}
        onChange={event => { update(event.target.value); setSaved(false); setError(null); }} /></label>)}
    <div className="flex justify-end"><button type="button" aria-pressed={visible} disabled={busy} onClick={() => setVisible(!visible)} className="flex shrink-0 items-center gap-1.5 rounded p-1 text-xs text-text-dim hover:text-text">{visible ? <EyeSlashIcon className="size-4" /> : <EyeIcon className="size-4" />}{visible ? m.hide : m.show}</button></div>
    {error && <p role="alert" className="text-sm">{error}</p>}
    {saved && <p role="status" className="flex items-center gap-2 text-sm"><CheckIcon className="size-4 shrink-0" />{m.saved}</p>}
    <button type="submit" disabled={busy || !current || !next || !confirm} className="flex items-center gap-2 rounded-md border border-border bg-bg-active px-4 py-2 text-sm hover:bg-bg-hover disabled:opacity-40">{busy && <ArrowPathIcon className="size-4 animate-spin" />}{busy ? m.saving : m.save}</button>
  </form>;
}
