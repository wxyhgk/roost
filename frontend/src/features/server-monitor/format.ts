// 刻度只有一份，见 shared/bytes.ts。这里再导出是为了让监控面板的格式化都从一个地方进。
export { bytes } from '../../shared/bytes';
export const percentage = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`;
export function uptime(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 86400)}d ${Math.floor(n / 3600) % 24}h ${Math.floor(n / 60) % 60}m`;
}
