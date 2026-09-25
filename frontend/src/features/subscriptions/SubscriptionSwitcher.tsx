import { useEffect, useId, useRef, useState } from 'react';
import { ArrowPathIcon, ChevronUpDownIcon, ClockIcon, KeyIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { primaryWindow, remainingPercent, type QuotaWindow, type SubscriptionSnapshot } from '@roost/subscriptions';
import { t } from '@roost/i18n';
import { connectClaudeSubscription, saveGoKey } from '../../shared/api/subscriptions';
import { RING, arcPath } from './arc';
import { providers, readProvider, saveProvider } from './providers';
import { acceptSubscription, refreshSubscription, useSubscription } from './store';
import './subscriptions.css';

function windowLabel(window: QuotaWindow) {
  if (window.label === 'primary' || window.label === 'secondary') {
    const seconds = window.durationSeconds;
    if (seconds != null) return seconds % 86400 === 0 ? seconds / 86400 + 'd' : seconds % 3600 === 0 ? seconds / 3600 + 'h' : Math.round(seconds / 60) + 'm';
  }
  return t.statusBar.windows[window.label as keyof typeof t.statusBar.windows] ?? window.label;
}
const dateText = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const number = (value: number | null) => value == null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) + '%';

export function SubscriptionSwitcher() {
  const id = useId(), popover = useRef<HTMLDivElement>(null), mutation = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState(readProvider), [open, setOpen] = useState(false), [keyOpen, setKeyOpen] = useState(false), [key, setKey] = useState('');
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(false);
  const state = useSubscription(selected), snapshot = state.snapshot, primary = primaryWindow(snapshot), remaining = remainingPercent(primary);
  const provider = providers.find(p => p.id === selected)!, m = t.statusBar;
  const arc = remaining == null ? null : arcPath(remaining);
  const stale = state.failed || snapshot?.state === 'stale' || !!snapshot?.observedAt && Date.now() - Date.parse(snapshot.observedAt) > 300000;
  const message = state.failed ? m.failed : snapshot?.issue ? m.issues[snapshot.issue] : !snapshot && state.loading ? m.reading : !snapshot ? m.unavailable : '';
  useEffect(() => () => { mutation.current?.abort(); }, []);
  async function configure(operation: (signal: AbortSignal) => Promise<SubscriptionSnapshot>) {
    mutation.current?.abort(); const controller = new AbortController(); mutation.current = controller;
    const deadline = setTimeout(() => controller.abort(), 30000); setSaving(true); setSaveError(false);
    try {
      const next = await operation(controller.signal);
      if (mutation.current !== controller) return;
      acceptSubscription(next); setKey(''); setKeyOpen(false);
    } catch { if (mutation.current === controller) setSaveError(true); }
    finally { clearTimeout(deadline); if (mutation.current === controller) { setSaving(false); mutation.current = null; } }
  }
  return <>
    <button type="button" popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-label={m.subscriptions + ' · ' + provider.name}
      title={provider.name + ' · ' + m.remaining + ' ' + number(remaining) + (primary ? ' · ' + windowLabel(primary) : '') + (stale ? ' · ' + m.stale : '')}
      className={'subscription-trigger status-button' + (stale ? ' subscription-stale' : '')}>
      {/*
        环画的是**剩余**，和它右边那个数字是同一个量——两者必须说同一句话，不然这颗按钮
        自己跟自己打架。（弹层里那根量表填的是「已用」，配的标签也是 Used N%，各自成立；
        同一份配额在两处按相反方向画，值得单独拉直，不在这次里做。）

        aria-hidden：数字和 title 已经把这件事说完了，屏读器再念一遍环是噪音。
      */}
      <span className="subscription-ring">
        <svg viewBox={`0 0 ${RING.size} ${RING.size}`} aria-hidden="true">
          <circle cx={RING.center} cy={RING.center} r={RING.radius} fill="none" strokeWidth={RING.stroke}
            className="subscription-ring-track" strokeDasharray={remaining == null ? '1.5 2' : undefined} />
          {arc && <path d={arc} fill="none" strokeWidth={RING.stroke} strokeLinecap="butt" className="subscription-ring-arc" />}
        </svg>
        <img src={provider.logo} alt="" className="subscription-logo" />
      </span><span className="tabular-nums">{number(remaining)}</span><ChevronUpDownIcon className="size-3" aria-hidden="true" />
    </button>
    <div id={id} ref={popover} popover="auto" role="dialog" aria-label={m.subscriptions}
      onToggle={event => { setOpen(event.newState === 'open'); if (event.newState !== 'open') { setKey(''); setKeyOpen(false); } }}
      className="subscription-popover chrome-surface" onKeyDown={event => event.stopPropagation()}>
      {/* 这是状态栏自己的弹层（.subscription-action 已经是 11px，状态栏也是 11px），
          里面全是配额读数和元数据。原来文字一律 text-xs(12)，紧挨着 11px 的按钮差 1px。
          整个弹层并到 text-caption。 */}
      <header className="flex items-center gap-2 border-b border-border p-3">
        <img src={provider.logo} alt="" className="subscription-logo" />
        <select aria-label={m.platform} value={selected} disabled={saving} className="min-w-0 flex-1 rounded border border-border bg-bg-panel px-2 py-1 text-caption"
          onChange={event => { const next = providers.find(p => p.id === event.target.value); if (next) { setSelected(next.id); saveProvider(next.id); setKey(''); setKeyOpen(false); setSaveError(false); } }}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" aria-label={m.refresh} title={m.refresh} disabled={state.loading || saving} onClick={() => void refreshSubscription(selected)} className="rounded p-1 hover:bg-bg-hover disabled:opacity-40"><ArrowPathIcon className={'size-4' + (state.loading ? ' animate-spin' : '')} /></button>
        <button type="button" aria-label={m.close} title={m.close} onClick={() => popover.current?.hidePopover()} className="rounded p-1 hover:bg-bg-hover"><XMarkIcon className="size-4" /></button>
      </header>
      <div className="space-y-4 p-4">
        <div><p className="text-caption text-text-dim">{m.remaining}{primary && ' · ' + windowLabel(primary)}</p>{/*
            这是整块弹窗里唯一要一眼看到的东西，所以给它体系外那根「仪表数字」轴
            （index.css 里写明 text-lg/2xl/3xl 属于另一根轴，不并进正文那三档）。
            2xl → 3xl 加半粗加紧字距：原来它和旁边的说明文字几乎一样重，扫一眼找不到。
          */}
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{number(remaining)}</p>
          {stale && <p className="mt-1 flex items-center gap-1 text-caption text-text-dim"><ClockIcon className="size-3" />{m.stale}</p>}
          {message && <p role="status" className="mt-2 text-caption text-text-dim">{message}</p>}
        </div>
        {!!snapshot?.windows.length && <div className="space-y-3">{snapshot.windows.map(window => <div key={window.id} className="subscription-window">
          <div className="flex justify-between gap-2 text-caption"><span title={window.scope} className="min-w-0 truncate">{windowLabel(window)}{selected === 'chatgpt' && ' · ' + window.scope}</span><span className="shrink-0 tabular-nums">{m.percentLeft(number(remainingPercent(window)))}</span></div>
          {/*
            量表填的是**剩余**，和状态栏那个环、和上面那个大字读数同一个方向。

            原来这里填的是「已用」、标签也写着 Used N%——单看自洽，但同一份配额在这个弹层
            里就有两种画法：顶上的大字是剩余，下面这几根是已用。满格在一处表示「还很多」，
            在另一处表示「快没了」，而它们上下紧挨着。统一到剩余。
          */}
          <div role="progressbar" aria-label={window.scope + ' ' + windowLabel(window) + ' ' + m.remaining} aria-valuenow={remainingPercent(window) ?? undefined} aria-valuemin={0} aria-valuemax={100} className="subscription-meter"><span style={{ width: (remainingPercent(window) ?? 0) + '%' }} /></div>
          <p className="mt-1 flex items-center gap-1 text-caption text-text-dim"><ClockIcon className="size-3" aria-hidden="true" />{m.reset} · {dateText(window.resetsAt)}</p>
        </div>)}</div>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-caption">
          {[[m.runtime, snapshot?.runtimeId], [m.account, snapshot?.accountLabel || (selected === 'claude' && snapshot?.windows.length ? m.sessionSource : null)], [m.plan, snapshot?.plan], [m.renewal, dateText(snapshot?.renewalAt)], [m.updated, dateText(snapshot?.observedAt)], [m.source, snapshot ? m.sources[snapshot.source] : null]].map(([label, value]) => <div key={label} className="contents"><dt className="text-text-dim">{label}</dt><dd className="min-w-0 break-words text-right">{value || '—'}</dd></div>)}
        </dl>
        {selected === 'claude' && snapshot?.canConnect && <button type="button" disabled={saving} className="subscription-action" onClick={() => void configure(connectClaudeSubscription)}>{m.connectClaude}</button>}
        {selected === 'opencode-go' && <div>
          <button type="button" aria-expanded={keyOpen} className="flex items-center gap-2 text-caption text-text-dim hover:text-text" onClick={() => { setKeyOpen(!keyOpen); setKey(''); }}><KeyIcon className="size-4" />{m.configureKey}</button>
          {keyOpen && <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); const value = key.trim(); if (value) { setKey(''); void configure(signal => saveGoKey(value, signal)); } }}>
            <input type="password" aria-label={m.key} value={key} autoComplete="off" spellCheck={false} maxLength={4096} onChange={event => setKey(event.target.value)} className="w-full rounded border border-border bg-bg-panel p-2 text-caption" />
            <div className="flex flex-wrap gap-2"><button type="submit" className="subscription-action" disabled={saving || !key.trim()}>{m.saveKey}</button><button type="button" className="subscription-action" disabled={saving} onClick={() => void configure(signal => saveGoKey(null, signal))}>{m.useCliAccount}</button></div>
          </form>}
        </div>}
        {saveError && <p role="alert" className="text-caption">{m.failed}</p>}
      </div>
    </div>
  </>;
}
