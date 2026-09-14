import { useState } from 'react';
import { IconTerminal } from '../icons';
import type { CliKind } from '../types';
import { useCliConfig } from '../cli-configs';
import { resolveCliIdentity } from './cli-identity';
import { CliAnimation, hasCliAnimation } from './cli-animation';
export { cliLabel } from './cli-identity';

export function useCliIdentity(cli?: CliKind | null, cliId?: string | null) {
  const config = useCliConfig(cliId === undefined ? cli : cliId);
  return resolveCliIdentity(cli, cliId, config);
}

const BOX = { sm: 'h-3.5 w-3.5', lg: 'h-7 w-7', xl: 'h-12 w-12' } as const;
// 兜底图标是 SVG，得单独把尺寸压进去——它不吃父元素的 h/w。
const SVG = { sm: '[&>svg]:h-3.5 [&>svg]:w-3.5', lg: '[&>svg]:h-7 [&>svg]:w-7', xl: '[&>svg]:h-12 [&>svg]:w-12' } as const;

export function SessionLogo({ cli, cliId, size = 'sm', working = false }: {
  cli?: CliKind | null; cliId?: string | null; size?: keyof typeof BOX;
  /**
   * 这个 CLI 正在回复。
   *
   * 默认 false：九个调用点里只有侧栏行和画布卡片知道活动状态，设置页、命令面板、
   * 对话列表那几处没有上下文，也不该动。
   */
  working?: boolean;
}) {
  const identity = useCliIdentity(cli, cliId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = BOX[size];
  const fallback = !identity.src || identity.src === failedSrc
    ? <span className={`grid h-full w-full place-items-center ${SVG[size]}`}><IconTerminal /></span>
    : <img className={`h-full w-full block object-contain${identity.monoLogo ? ' session-logo-mono' : ''}`}
        src={identity.src} alt={identity.label} onError={() => setFailedSrc(identity.src)} />;
  // 回复中且这个 CLI 有动画才挂——判断是纯函数，不会因此加载任何东西。
  if (working && hasCliAnimation(identity.builtin)) {
    return <CliAnimation builtin={identity.builtin!} label={identity.label} className={`${box} shrink-0 block`}>{fallback}</CliAnimation>;
  }
  return <span role="img" aria-label={identity.label} title={identity.label} className={`${box} shrink-0 block`}>{fallback}</span>;
}
