import type { Terminal } from '@xterm/xterm';
import { bufferFileLinks } from './fileLinkBuffer';
import { isMac, linkModifier } from './keys';
import { t } from '@roost/i18n';

/**
 * 把输出里的文件路径变成可点的链接，并在悬浮时给一条提示。
 *
 * **从 xtermEngine 搬出来的。** 那个文件是 `Terminal` → `TermHandle` 的适配器，而这一块
 * 的变化原因是「文件链接」这个功能本身——提示怎么写、长什么样、点一下算不算数——和 xterm
 * 的 API 没有关系。纯解析那一半早就在 `fileLinkBuffer.ts` 里了，这里是它的另一半：DOM。
 *
 * 返回 detach：`filePress`、`linkHint` 和那两个 host 监听器全归这里管，调用方只需要在
 * `dispose()` 里调一次，不必知道拆的是哪几样东西。
 */
export function attachFileLinks(
  term: Terminal,
  host: HTMLElement,
  onFileLink?: (link: { path: string; line?: number }) => void,
): () => void {
  /*
    **按下和松开必须是同一个点。** xterm 的 link `activate` 只管「在链接上松开了鼠标」，
    所以拖选文本时最后一下若正好落在链接上，它也会当成点击——选完一段路径反而跳去开文件。
    自己记按下的位置，移动超过 4px 就判成拖拽，这一下不算点击。
  */
  let press: { x: number; y: number; dragged: boolean } | null = null;
  const onDown = (event: MouseEvent) => {
    press = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : null;
  };
  const onMove = (event: MouseEvent) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.dragged = true;
  };
  host.addEventListener('mousedown', onDown, true);
  host.addEventListener('mousemove', onMove, true);

  let hint: HTMLDivElement | null = null;
  const hideHint = () => { hint?.remove(); hint = null; };

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const links = bufferFileLinks(term.buffer.active, y, term.cols).map(m => ({
        range: m.range,
        text: m.path,
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          const started = press;
          press = null;
          if (!linkModifier(event) || event.button !== 0 || !started || started.dragged
            || Math.hypot(event.clientX - started.x, event.clientY - started.y) > 4) return;
          event.preventDefault();
          hideHint();
          onFileLink?.({ path: m.path, line: m.line });
        },
        hover: () => {
          hideHint();
          hint = document.createElement('div');
          // 字号和 TermView 里那几条终端浮层一致（text-caption），它们是同一类东西。
          hint.className = 'xterm-hover absolute left-2 right-2 top-1 z-20 pointer-events-none rounded border border-border bg-bg-panel px-3 py-2 text-caption text-text shadow-lg break-words';
          hint.textContent = t.misc.terminal.openLinkHint(
            isMac() ? '⌘ Command' : 'Ctrl',
            m.path,
            m.line ? t.misc.terminal.lineSuffix(m.line) : '',
          );
          term.element?.append(hint);
        },
        leave: hideHint,
        dispose: hideHint,
      }));
      callback(links.length ? links : undefined);
    },
  });

  return () => {
    host.removeEventListener('mousedown', onDown, true);
    host.removeEventListener('mousemove', onMove, true);
    hideHint();
    provider.dispose();
  };
}
