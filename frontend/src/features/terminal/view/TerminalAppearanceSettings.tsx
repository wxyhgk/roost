import { useTheme, type TerminalAppearance } from "../../../shared/theme";
import { t } from "@roost/i18n";

export function TerminalAppearanceSettings() {
  const { terminalAppearance, setTerminalAppearance, terminalContrast, setTerminalContrast, terminalAccel, setTerminalAccel } = useTheme();
  return (
    /* 挂在 PanelHeader 的 actions 里，和 13px 的标题同一排：这是控件，跟着走 text-body，
       别在标题和元信息之间再插一个 12px。font-normal 是为了不继承标题的 semibold。 */
    <details className="relative text-body font-normal">
      <summary className="cursor-pointer list-none rounded px-2 py-1 text-text-dim hover:bg-bg-hover hover:text-text" aria-label={t.settings.terminal.triggerLabel}>{t.settings.terminal.trigger}</summary>
      {/* 小浮层，和终端上方那几条状态条同一个尺寸量级，所以跟着用 glass；理由见 index.css。 */}
      <div className="glass absolute right-0 top-8 z-30 w-64 space-y-3 rounded-lg p-3 text-text shadow-pop">
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
        {/*
          纯性能开关。默认开着；真机上觉得哪里不对就关掉，立刻回到 DOM 渲染器。
          留这个开关是因为「顺不顺」只有眼睛判断得了——这台机器上的无头浏览器连 WebGL 都没有。
        */}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={terminalAccel} onChange={event => setTerminalAccel(event.target.checked)} />
          {t.settings.terminal.accel}
        </label>
        <p className="leading-relaxed text-text-dim">{t.settings.terminal.accelHint}</p>
        <p className="leading-relaxed text-text-dim">{t.settings.terminal.hint}</p>
      </div>
    </details>
  );
}
