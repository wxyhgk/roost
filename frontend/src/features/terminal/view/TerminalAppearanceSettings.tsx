import { useTheme, type TerminalAppearance } from "../../../shared/theme";
import { t } from "@roost/i18n";

export function TerminalAppearanceSettings() {
  const { terminalAppearance, setTerminalAppearance, terminalContrast, setTerminalContrast } = useTheme();
  return (
    /* 挂在 PanelHeader 的 actions 里，和 13px 的标题同一排：这是控件，跟着走 text-body，
       别在标题和元信息之间再插一个 12px。font-normal 是为了不继承标题的 semibold。 */
    <details className="relative text-body font-normal">
      <summary className="cursor-pointer list-none rounded px-2 py-1 text-text-dim hover:bg-bg-hover hover:text-text" aria-label={t.settings.terminal.triggerLabel}>{t.settings.terminal.trigger}</summary>
      <div className="absolute right-0 top-8 z-30 w-64 space-y-3 rounded-lg border border-border bg-bg-panel p-3 text-text shadow-pop">
        <label className="flex items-center justify-between gap-2">
          {t.settings.terminal.label}
          <select aria-label={t.settings.terminal.label} value={terminalAppearance} onChange={event => setTerminalAppearance(event.target.value as TerminalAppearance)} className="rounded border border-border bg-bg px-2 py-1 text-text">
            <option value="follow">{t.settings.terminal.follow}</option>
            <option value="dark">{t.settings.terminal.dark}</option>
            <option value="light">{t.settings.terminal.light}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={terminalContrast} onChange={event => setTerminalContrast(event.target.checked)} />
          {t.settings.terminal.contrast}
        </label>
        <p className="leading-relaxed text-text-dim">{t.settings.terminal.hint}</p>
      </div>
    </details>
  );
}
