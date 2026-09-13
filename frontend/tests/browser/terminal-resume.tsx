import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '/src/shared/theme';
import { WorkspaceProvider } from '/src/shared/store';
import { TermView } from '/src/features/terminal/view/TermView';
import '/src/index.css';
const scenarios = { syncing: '同步后可恢复', conflict: '提交时身份变化', unconfirmed: '无法确认', unavailable: '服务不可用' };
function Fixture() {
  const [id, setId] = useState('syncing'), [active, setActive] = useState(true), [stats, setStats] = useState('');
  useEffect(() => {
    const timer = setInterval(() => void fetch('/api/test-stats').then(response => response.json()).then(value => setStats(JSON.stringify(value))), 500);
    return () => clearInterval(timer);
  }, []);
  return <main className="h-screen bg-bg p-4 text-text">
    <h1>恢复对话验收（独立模拟服务）</h1>
    <nav className="flex flex-wrap gap-4 py-3">{Object.entries(scenarios).map(([key, label]) => <button key={key} onClick={() => setId(key)}>{label}</button>)}
      <button onClick={() => setActive(value => !value)}>{active ? '隐藏终端' : '显示终端'}</button>
    </nav>
    <div className="relative h-[65vh] border border-border"><TermView key={id} sessionId={id} active={active} onCwd={() => {}} onCli={() => {}} /></div>
    <pre aria-label="请求计数" className="whitespace-pre-wrap break-all text-xs">{stats}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider>);
