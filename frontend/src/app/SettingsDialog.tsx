import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SwatchIcon, CommandLineIcon, CpuChipIcon, XMarkIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { useTheme, type TerminalAppearance } from '../shared/theme';
import { CliSettings } from './CliSettings';
import { PasswordSettings } from './PasswordSettings';
import { t } from '@roost/i18n';
import { setLocale, useLocale, type Locale } from '../shared/locale';
import { desktopRuntime } from '../shared/runtime';

type SectionId = 'appearance' | 'terminal' | 'cli' | 'security';
const SECTION_IDS = ['appearance', 'terminal', 'cli', 'security'] as const;
const SECTION_ICONS = { appearance: SwatchIcon, terminal: CommandLineIcon, cli: CpuChipIcon, security: LockClosedIcon } as const;

export function SettingsDialog({ onClose, onResetLayout }: { onClose(): void; onResetLayout(): void }) {
  const locale = useLocale();
  // 每次渲染重取：切换语言后分类名要跟着变，不能缓存在模块顶层。
  const sections = SECTION_IDS.filter(id => !desktopRuntime || id !== 'security').map(id => ({ id, name: t.settings.dialog.sections[id], Icon: SECTION_ICONS[id] }));
  const dialog = useRef<HTMLDialogElement>(null);
  const cliDirty = useRef(false);
  const cliBusy = useRef(false);
  const passwordBusy = useRef(false);
  const onPasswordBusy = useCallback((value: boolean) => { passwordBusy.current = value; }, []);
  const canLeave = () => !cliBusy.current && !passwordBusy.current && (!cliDirty.current || window.confirm(t.settings.dialog.unsavedConfirm));
  const close = () => { if (canLeave()) onClose(); };
  const [section, setSection] = useState<SectionId>('appearance');
  const { theme, toggleTheme, terminalAppearance, setTerminalAppearance, terminalContrast, setTerminalContrast } = useTheme();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  /*
    这个对话框原来是 14/12（Tailwind 默认的 text-sm/text-xs），而它的三个分区各自
    挑了不同的那一档：PasswordSettings 的字段标签 14、CliSettings 的字段标签 12，
    两边包的是同一个 text-sm 输入框。同一个角色两个字号，差 1px 不携带意义。

    并到令牌：控件与行标签 text-body(13)、说明与状态 text-caption(11)。
    对照组是同一组里的登录页 AuthGate——那也是阅读面，已经是 13/11/15。
    顺带把 h3 从 14 挪开：它和 h2 的 text-title(15) 只差 1px，看不出是下一级。
  */
  const control = 'rounded-md border border-border bg-bg px-3 py-2 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return createPortal(
    <dialog ref={dialog} aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}
      className="fixed inset-0 m-auto h-[min(720px,85dvh)] max-h-[85dvh] w-[min(1080px,94vw)] max-w-[94vw] overflow-hidden rounded-xl border border-border bg-bg-panel p-0 text-text shadow-2xl backdrop:bg-black/50">
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <h2 id="settings-title" className="text-title font-semibold">{t.settings.dialog.title}</h2>
          <button type="button" aria-label={t.settings.dialog.close} title={t.settings.dialog.closeTitle} onClick={close} className="grid size-8 place-items-center rounded-md text-text-dim hover:bg-bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent"><XMarkIcon className="size-5" /></button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label={t.settings.dialog.navLabel} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 sm:w-40 sm:flex-col sm:border-r sm:border-b-0">
            {sections.map(({ id, name, Icon }) => <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => { if (id !== section && canLeave()) setSection(id); }}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-body focus-visible:outline-2 focus-visible:outline-accent ${section === id ? 'bg-bg-active text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}><Icon className="size-4" />{name}</button>)}
          </nav>
          <section aria-label={sections.find(item => item.id === section)!.name} className={`min-h-0 min-w-0 flex-1 p-6 ${section === 'cli' ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}>
            <h3 className="mb-5 shrink-0 text-body font-semibold">{sections.find(item => item.id === section)!.name}</h3>
            {section === 'appearance' && <div className="space-y-5">
              <label className="flex items-center justify-between gap-4 text-body">{t.settings.dialog.appearance.language}
                <select className={control} value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh">{t.settings.dialog.appearance.languageZh}</option><option value="en">{t.settings.dialog.appearance.languageEn}</option></select>
              </label>
              <label className="flex items-center justify-between gap-4 text-body">{t.settings.dialog.appearance.theme}
                <select className={control} value={theme} onChange={event => { if (event.target.value !== theme) toggleTheme(); }}><option value="dark">{t.settings.dialog.appearance.dark}</option><option value="light">{t.settings.dialog.appearance.light}</option></select>
              </label>
              <div className="flex items-center justify-between gap-4 text-body"><div>{t.settings.dialog.appearance.layout}<p className="mt-1 text-caption text-text-dim">{t.settings.dialog.appearance.layoutDetail}</p></div><button type="button" className={control} onClick={onResetLayout}>{t.settings.dialog.appearance.resetLayout}</button></div>
              <p className="text-caption leading-relaxed text-text-dim">{t.settings.dialog.appearance.hint}</p>
            </div>}
            {section === 'terminal' && <div className="space-y-5">
              <label className="flex items-center justify-between gap-4 text-body">{t.settings.terminal.label}
                <select className={control} value={terminalAppearance} onChange={event => setTerminalAppearance(event.target.value as TerminalAppearance)}><option value="follow">{t.settings.terminal.follow}</option><option value="dark">{t.settings.terminal.dark}</option><option value="light">{t.settings.terminal.light}</option></select>
              </label>
              <label className="flex items-center justify-between gap-4 text-body">{t.settings.terminal.contrast}<input type="checkbox" checked={terminalContrast} onChange={event => setTerminalContrast(event.target.checked)} className="size-4 accent-accent" /></label>
              <p className="text-caption leading-relaxed text-text-dim">{t.settings.terminal.dialogHint}</p>
            </div>}
            {section === 'cli' && <CliSettings onDirtyChange={value => { cliDirty.current = value; }} onBusyChange={value => { cliBusy.current = value; }} />}
            {section === 'security' && <PasswordSettings onBusyChange={onPasswordBusy} />}
          </section>
        </div>
      </div>
    </dialog>, document.body,
  );
}
