import { DEFAULT_CLI_DEFINITIONS, resumeArgv } from '@roost/cli-adapters';
import type { Bookmark } from '../../shared/api/bookmarks';

export const quoteArg = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function bookmarkResumeCommand(card: Pick<Bookmark, 'cliId' | 'nativeSessionId' | 'cwd'>): string | null {
  const argv = resumeArgv(DEFAULT_CLI_DEFINITIONS.find(cli => cli.id === card.cliId), card.nativeSessionId);
  if (!argv) return null;
  const command = argv.map(quoteArg).join(' ');
  return card.cwd ? `cd -- ${quoteArg(card.cwd)} && ${command}` : command;
}
export function filterBookmarks(cards: Bookmark[], group: string | null, cli: string, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => (group === null || (card.groupId ?? '') === group) && (!cli || card.cliId === cli)
    && words.every(word => [card.title, card.note, card.cwd, card.cliId, card.nativeSessionId].some(value => value?.toLocaleLowerCase().includes(word))));
}
