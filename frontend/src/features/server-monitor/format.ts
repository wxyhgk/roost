export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? n >= 100 ? 0 : 1 : 0)} ${units[i]}`;
}
export const percentage = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`;
export function uptime(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 86400)}d ${Math.floor(n / 3600) % 24}h ${Math.floor(n / 60) % 60}m`;
}
