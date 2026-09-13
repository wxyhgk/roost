import { useState } from 'react';
import { IconTerminal } from '../icons';
import type { CliKind } from '../types';
import { useCliConfig } from '../cli-configs';
import { resolveCliIdentity } from './cli-identity';
export { cliLabel } from './cli-identity';

export function useCliIdentity(cli?: CliKind | null, cliId?: string | null) {
  const config = useCliConfig(cliId === undefined ? cli : cliId);
  return resolveCliIdentity(cli, cliId, config);
}

const BOX = { sm: 'h-3.5 w-3.5', lg: 'h-7 w-7', xl: 'h-12 w-12' } as const;
// 兜底图标是 SVG，得单独把尺寸压进去——它不吃父元素的 h/w。
const SVG = { sm: '[&>svg]:h-3.5 [&>svg]:w-3.5', lg: '[&>svg]:h-7 [&>svg]:w-7', xl: '[&>svg]:h-12 [&>svg]:w-12' } as const;

export function SessionLogo({ cli, cliId, size = 'sm' }: {
  cli?: CliKind | null; cliId?: string | null; size?: keyof typeof BOX;
}) {
  const identity = useCliIdentity(cli, cliId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = BOX[size];
  if (!identity.src || identity.src === failedSrc) {
    const svg = SVG[size];
    return <span role="img" aria-label={identity.label} title={identity.label} className={`grid ${box} shrink-0 place-items-center ${svg}`}><IconTerminal /></span>;
  }
  return <img className={`${box} shrink-0 block object-contain${identity.monoLogo ? ' session-logo-mono' : ''}`}
    src={identity.src} alt={identity.label} title={identity.label} onError={() => setFailedSrc(identity.src)} />;
}
