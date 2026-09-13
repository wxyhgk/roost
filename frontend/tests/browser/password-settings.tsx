import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '/src/shared/theme';
import { AuthGate } from '/src/app/AuthGate';
import { SettingsDialog } from '/src/app/SettingsDialog';
import { logout } from '/src/shared/api/auth';
import { request } from '/src/shared/api/request';
import '/src/index.css';
function Fixture() {
  const [open, setOpen] = useState(false);
  const [lateResult, setLateResult] = useState('');
  useEffect(() => { const timer = setInterval(() => void request('/api/test-heartbeat').catch(() => {}), 1000); return () => clearInterval(timer); }, []);
  return <AuthGate><main className="h-screen bg-bg p-6 text-text"><h1>密码设置验收（独立测试账号）</h1>
    <button type="button" onClick={() => setOpen(true)}>打开设置</button>
    <button type="button" onClick={() => void logout().then(() => location.reload())}>退出测试账号</button>
    <button type="button" onClick={() => { setLateResult('旧请求等待中'); void request('/api/test-delayed-expiry').catch(() => setLateResult('旧 401 已到达')); }}>模拟迟到的过期响应</button>
    <button type="button" onClick={() => void request('/api/test-release-expiry', { method: 'POST' })}>释放旧 401</button>
    <p role="status">{lateResult}</p>
    {open && <SettingsDialog onClose={() => setOpen(false)} onResetLayout={() => {}} />}
  </main></AuthGate>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><Fixture /></ThemeProvider>);
