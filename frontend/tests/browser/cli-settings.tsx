import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '/src/shared/theme';
import { SettingsDialog } from '/src/app/SettingsDialog';
import { SessionLogo } from '/src/shared/ui/SessionLogo';
import { useCliConfigs } from '/src/shared/cli-configs/index';
import '/src/index.css';
function Fixture() {
  const [open, setOpen] = useState(true);
  const { configs } = useCliConfigs();
  return <div className="h-screen bg-bg p-6 text-text"><h1>CLI 设置验收（不连接终端）</h1><button onClick={() => setOpen(true)}>打开设置</button>
    <section aria-label="会话标识预览" className="mt-6 space-y-3">{configs.map(config => <div key={config.id} className="flex items-center gap-3"><SessionLogo cliId={config.id} size="lg"/><span>{config.name}</span></div>)}</section>
    {open && <SettingsDialog onClose={() => setOpen(false)} onResetLayout={() => {}}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><Fixture/></ThemeProvider>);
