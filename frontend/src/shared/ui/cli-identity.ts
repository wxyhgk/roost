import type { CliKind } from '../types';

const LOGOS: Record<CliKind, { src: string; label: string }> = {
  claude: { src: '/logos/claude-color.svg', label: 'Claude Code' },
  codex: { src: '/logos/codex-color.svg', label: 'Codex' },
  grok: { src: '/logos/grok.svg', label: 'Grok' },
  qwen: { src: '/logos/qwen-color.svg', label: 'Qwen' },
};
/** 素材本身没有固有颜色（fill="currentColor"），在 <img> 里会渲染成黑色。 */
const MONO_LOGOS = new Set(['grok', 'codex']);
type DisplayConfig = { id: string; name: string; iconUrl: string | null; iconRef: string | null };
export function cliLabel(cli?: string | null): string {
  return cli && Object.hasOwn(LOGOS, cli) ? LOGOS[cli as CliKind].label : cli ? 'AI CLI' : 'Shell';
}
export function resolveCliIdentity(cli: string | null | undefined, cliId: string | null | undefined, config?: DisplayConfig) {
  const id = cliId === undefined ? cli : cliId;
  if (!id) return { label: 'Shell', src: null, monoLogo: false, builtin: null };
  if (config?.id === id) {
    const builtin = config.iconRef?.startsWith('builtin:') ? config.iconRef.slice('builtin:'.length) : null;
    return { label: config.name, src: config.iconUrl, monoLogo: !!builtin && MONO_LOGOS.has(builtin), builtin };
  }
  // Only older servers without cliId may use bundled identities. A deleted or
  // unknown modern id must not silently inherit a legacy brand or capability.
  const legacy = cliId === undefined && Object.hasOwn(LOGOS, id) ? LOGOS[id as CliKind] : undefined;
  return { label: legacy?.label ?? 'AI CLI', src: legacy?.src ?? null,
    monoLogo: !!legacy && MONO_LOGOS.has(id), builtin: legacy ? id : null };
}
