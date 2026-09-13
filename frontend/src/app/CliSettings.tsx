import { useEffect, useRef, useState } from 'react';
import { CommandLineIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useCliConfigs, type CliConfig, type CliConfigInput, type CliRule } from '../shared/cli-configs';
import { SessionLogo } from '../shared/ui/SessionLogo';
import { t } from '@roost/i18n';

const control = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent';
const button = 'rounded-md border border-border px-3 py-2 text-xs hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40';
type Draft = { name: string; command: string; enabled: boolean; priority: string; rules: CliRule[] };
const blank = (): Draft => ({ name: '', command: '', enabled: true, priority: '0', rules: [{ kind: 'executable', value: '' }] });
const toDraft = (config: CliConfig): Draft => ({ name: config.name, command: config.command, enabled: config.enabled, priority: String(config.priority), rules: config.rules.map(rule => ({ ...rule })) });
function input(draft: Draft): CliConfigInput {
  const priority = Number(draft.priority);
  if (!draft.name.trim() || !draft.command.trim()) throw new Error(t.settings.cli.validation.nameCommand);
  if (!draft.priority.trim() || !Number.isInteger(priority) || priority < -1000 || priority > 1000) throw new Error(t.settings.cli.validation.priority);
  if (draft.rules.length < 1 || draft.rules.length > 32 || draft.rules.some(rule => !rule.value.trim())) throw new Error(t.settings.cli.validation.rules);
  return { ...draft, name: draft.name.trim(), command: draft.command.trim(), priority, rules: draft.rules.map(rule => ({ ...rule, value: rule.value.trim() })) };
}

export function CliSettings({ onDirtyChange, onBusyChange }: { onDirtyChange(value: boolean): void; onBusyChange(value: boolean): void }) {
  const api = useCliConfigs();
  const [selected, setSelected] = useState<CliConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); setMessage(''); };
  const choose = (config: CliConfig | null) => {
    if (inFlight.current || (dirty && !window.confirm(t.settings.cli.discardConfirm))) return;
    setSelected(config); setDraft(config ? toDraft(config) : blank()); setEditing(true); setDirty(false); setError(''); setMessage('');
  };
  const accept = (config: CliConfig) => { setSelected(config); setDraft(toDraft(config)); setDirty(false); };
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : t.settings.cli.fallbackError); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const save = async () => {
    const value = input(draft);
    const config = selected ? await api.update(selected.id, value) : await api.create(value);
    accept(config);
    return config;
  };
  const upload = (file: File) => run(async () => {
    if (!['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t.settings.cli.validation.iconType);
    if (file.size > 1024 * 1024) throw new Error(t.settings.cli.validation.iconSize);
    const config = !selected || dirty ? await save() : selected;
    accept(await api.uploadIcon(config.id, file)); setMessage(t.settings.cli.logo.saved);
  });
  const remote = selected ? api.configs.find(item => item.id === selected.id) : undefined;
  const remoteChanged = selected && JSON.stringify(remote) !== JSON.stringify(selected);
  return <div className="flex min-h-0 flex-1 flex-col gap-4">
    <div className="flex shrink-0 items-center justify-between gap-3"><p className="text-xs leading-relaxed text-text-dim">{t.settings.cli.headerHint}</p><button type="button" className={`${button} flex shrink-0 items-center gap-1`} disabled={busy} onClick={() => choose(null)}><PlusIcon className="size-4" />{t.settings.cli.create}</button></div>
    {api.error && <div role="alert" className="rounded-md border border-border p-3 text-xs">{api.error}<button type="button" className={`${button} ml-2`} onClick={() => { void api.refresh().catch(() => {}); }}>{t.settings.cli.retry}</button></div>}
    {api.loading && <p role="status" className="text-xs text-text-dim">{t.settings.cli.loading}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto md:grid-cols-[220px_minmax(0,1fr)] md:overflow-hidden">
    <div className="flex flex-col gap-2 md:min-h-0 md:overflow-y-auto md:pr-2" aria-label={t.settings.cli.listLabel}>
      {api.configs.map(config => <button key={config.id} type="button" disabled={busy} aria-pressed={editing && selected?.id === config.id} onClick={() => choose(config)} className={`${button} flex min-h-12 w-full min-w-0 shrink-0 items-center gap-3 text-left text-sm ${editing && selected?.id === config.id ? 'bg-bg-active' : ''}`}>
        <span className="flex shrink-0 items-center"><SessionLogo cliId={config.id} /></span><span className="min-w-0 flex-1 break-words">{config.name}</span><span className="shrink-0 text-text-dim">{!config.enabled ? t.settings.cli.status.disabled : config.builtin ? t.settings.cli.status.builtin : t.settings.cli.status.custom}</span>
      </button>)}
    </div>
    <div className="min-w-0 md:min-h-0 md:overflow-y-auto md:border-l md:border-border md:pl-5 md:pr-1">
    {!editing && !api.loading && <p className="text-xs text-text-dim">{t.settings.cli.empty}</p>}
    {editing && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void run(async () => { await save(); setMessage(t.settings.cli.saved); }); }}>
      {remoteChanged && !busy && <p className="text-xs text-text-dim">{t.settings.cli.serverChanged}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-4 disabled:opacity-60">
        <div className="flex items-center gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border">{selected ? <SessionLogo cliId={selected.id} size="lg" /> : <CommandLineIcon className="size-6" />}</div><div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => fileInput.current?.click()}>{t.settings.cli.logo.upload}</button><button type="button" className={button} disabled={!selected} onClick={() => { void run(async () => { const config = dirty ? await save() : selected!; accept(await api.update(config.id, { iconRef: null })); setMessage(t.settings.cli.logo.genericDone); }); }}>{t.settings.cli.logo.generic}</button></div></div>
        <input ref={fileInput} type="file" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp" aria-label={t.settings.cli.logo.label} className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
        <p className="text-xs text-text-dim">{t.settings.cli.logo.hint}</p>
        <label className="block space-y-1 text-xs"><span>{t.settings.cli.form.name}</span><input required className={control} value={draft.name} onChange={event => change({ name: event.target.value })} /></label>
        <label className="block space-y-1 text-xs"><span>{t.settings.cli.form.command}</span><input required className={control} value={draft.command} placeholder={t.settings.cli.form.commandPlaceholder} onChange={event => change({ command: event.target.value })} /></label>
        <div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-accent" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />{t.settings.cli.form.enabled}</label><label className="flex items-center gap-2 text-xs">{t.settings.cli.form.priority}<input type="number" min={-1000} max={1000} step={1} required className={`${control} max-w-24`} value={draft.priority} onChange={event => change({ priority: event.target.value })} /></label></div>
        <div className="space-y-2"><div className="flex items-center justify-between"><span className="text-xs">{t.settings.cli.rules.title}</span><button type="button" className={button} disabled={draft.rules.length >= 32} onClick={() => change({ rules: [...draft.rules, { kind: 'executable', value: '' }] })}>{t.settings.cli.rules.add}</button></div>
          {draft.rules.map((rule, index) => <div key={index} className="flex flex-wrap gap-2 rounded-md border border-border p-2"><select aria-label={t.settings.cli.rules.typeLabel(index)} className={`${control} sm:max-w-40`} value={rule.kind} onChange={event => change({ rules: draft.rules.map((item, at) => at === index ? { ...item, kind: event.target.value as CliRule['kind'] } : item) })}><option value="executable">{t.settings.cli.rules.kinds.executable}</option><option value="script">{t.settings.cli.rules.kinds.script}</option><option value="executablePathContains">{t.settings.cli.rules.kinds.pathContains}</option></select><input required aria-label={t.settings.cli.rules.valueLabel(index)} className={`${control} min-w-28 flex-1`} value={rule.value} placeholder={rule.kind === 'executable' ? 'chemist' : 'chemist/main.py'} onChange={event => change({ rules: draft.rules.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} /><button type="button" aria-label={t.settings.cli.rules.deleteLabel(index)} className={button} disabled={draft.rules.length <= 1} onClick={() => change({ rules: draft.rules.filter((_, at) => at !== index) })}><TrashIcon className="size-4" /></button></div>)}
          <p className="text-xs text-text-dim">{t.settings.cli.rules.hint}</p>
        </div>
        <p className="text-xs text-text-dim">{t.settings.cli.capabilities.text}{selected?.capabilities.image ? t.settings.cli.capabilities.withImage : t.settings.cli.capabilities.noImage}{selected && <span className="mt-1 block break-all">{t.settings.cli.capabilities.id(selected.id)}</span>}</p>
        <div className="flex flex-wrap gap-2"><button type="submit" className={`${button} bg-bg-active`}>{busy ? t.settings.cli.actions.saving : t.settings.cli.actions.save}</button>{selected?.builtin && <button type="button" className={button} onClick={() => { if (window.confirm(t.settings.cli.actions.resetConfirm)) void run(async () => { accept(await api.reset(selected.id)); setMessage(t.settings.cli.actions.resetDone); }); }}>{t.settings.cli.actions.reset}</button>}{selected && <button type="button" className={button} onClick={() => { if (window.confirm(selected.builtin ? t.settings.cli.actions.disableConfirm : t.settings.cli.actions.deleteConfirm)) void run(async () => { await api.remove(selected.id); setSelected(null); setEditing(false); setDirty(false); setMessage(selected.builtin ? t.settings.cli.actions.disabledDone : t.settings.cli.actions.removedDone); }); }}>{selected.builtin ? t.settings.cli.actions.disable : t.settings.cli.actions.remove}</button>}</div>
      </fieldset>
      {dirty && !busy && <p className="text-xs text-text-dim">{t.settings.cli.dirty}</p>}
    </form>}
    {busy && <p role="status" className="text-xs text-text-dim">{t.settings.cli.savingStatus}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{t.settings.cli.errorSuffix(error)}</p>}
    {message && <p role="status" className="text-xs text-text-dim">{message}</p>}
    </div>
    </div>
  </div>;
}
