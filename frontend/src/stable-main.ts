import { t } from "@roost/i18n";
async function start() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw Error(t.misc.bootstrap.configFailed);
  window.workbenchConfig = await response.json();
  await import('./main');
}
void start().catch(error => {
  const root = document.getElementById('root')!;
  root.textContent = `${error instanceof Error ? error.message : t.misc.bootstrap.startFailed}。`;
  const retry = document.createElement('button'); retry.textContent = t.misc.bootstrap.retry; retry.onclick = () => location.reload(); root.append(retry);
});
export {};
