import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '/src/shared/theme';
import { WorkspaceProvider, useWorkspace } from '/src/shared/store';
import { TerminalSurface } from '/src/features/terminal/view/TerminalSurface';
import { getTerminalHandle, subscribeTerminalHandle } from '/src/features/terminal/public';
import '/src/index.css';

/*
  **同一个活着的终端换落点**的验收台。

  单测钉得住「宿主被搬过去而不是重建」，钉不住「搬完之后屏幕上的内容还在、尺寸还对」——
  后者要真的有 xterm、有 PTY、有两个宽度不同的落点。两个落点刻意放在 React 树的不同位置
  （这正是 Shell 里中栏和右侧停靠面的关系），所以按一下按钮就是一次真正的卸载 + 挂载。

  跑法：`HOST=0.0.0.0 FIXTURE_LIVE=1 node --import tsx frontend/tests/browser/conversation-ui-server.mts`
  然后开 `/tests/browser/terminal-surface.html`。
*/
function Grid({ sessionId }: { sessionId: string | null }) {
  const [text, setText] = useState('—');
  useEffect(() => {
    if (!sessionId) return;
    const read = () => {
      const handle = getTerminalHandle(sessionId);
      setText(handle ? `${handle.cols}×${handle.rows}` : '—');
    };
    read();
    const stop = subscribeTerminalHandle(sessionId, read);
    const timer = setInterval(read, 300);
    return () => { stop(); clearInterval(timer); };
  }, [sessionId]);
  return <span aria-label="终端网格" data-grid={text} className="font-mono text-xs text-text-dim">{text}</span>;
}

function Fixture() {
  const { sessions, selectedId } = useWorkspace('sessions', 'selectedId');
  const open = sessions.filter(s => !s.closed);
  const current = open.find(s => s.id === selectedId) ?? open[0] ?? null;
  const [where, setWhere] = useState<'middle' | 'dock'>('middle');
  return <main className="flex h-screen flex-col bg-bg p-3 text-text">
    <nav className="flex items-center gap-3 pb-3">
      <button data-testid="toggle" className="rounded border border-border px-3 py-1"
        onClick={() => setWhere(value => (value === 'middle' ? 'dock' : 'middle'))}>
        {where === 'middle' ? '搬到右栏' : '搬回中栏'}
      </button>
      <span className="text-xs text-text-dim">落点：{where === 'middle' ? '中栏（宽）' : '右侧停靠面（窄）'}</span>
      <Grid sessionId={current?.id ?? null} />
    </nav>
    <div className="flex min-h-0 flex-1 gap-3">
      {/* 中栏：宽的那个落点 */}
      <div data-testid="middle" className="relative flex min-w-0 flex-1 flex-col overflow-hidden border border-border bg-bg">
        {where === 'middle' && <TerminalSurface sessionId={current?.id ?? null} />}
      </div>
      {/* 右侧停靠面：窄的那个落点，宽度和中栏差一截，不重新 fit 就会看出行列数不对 */}
      <div data-testid="dock" className="relative flex w-[380px] shrink-0 flex-col overflow-hidden border border-border bg-bg">
        {where === 'dock' && <TerminalSurface sessionId={current?.id ?? null} />}
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider>);
