// The same App is compiled for development and for immutable local releases.
export const stableRuntime = (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'stable';
type Config = { coreUrl: string; version: string };
declare global { interface Window { workbenchConfig?: Config } }
export function coreUrl(path: string) {
  return new URL(path, window.workbenchConfig?.coreUrl ?? 'http://127.0.0.1:8788').toString();
}
