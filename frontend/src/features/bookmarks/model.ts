import { DEFAULT_CLI_DEFINITIONS, resumeArgv } from '@roost/cli-adapters';
import type { Bookmark } from '../../shared/api/bookmarks';
import { shellQuote } from '../../shared/shell';

/* 原来这里自己写了一份 `quoteArg`，实现是对的但只有这一处用得上；而终端那边另有一份
   弱的。合并到 `shared/shell.ts`，两边共用同一个答案。 */
export { shellQuote as quoteArg };
export function bookmarkResumeCommand(card: Pick<Bookmark, 'cliId' | 'nativeSessionId' | 'cwd'>): string | null {
  const argv = resumeArgv(DEFAULT_CLI_DEFINITIONS.find(cli => cli.id === card.cliId), card.nativeSessionId);
  if (!argv) return null;
  const command = argv.map(shellQuote).join(' ');
  return card.cwd ? `cd -- ${shellQuote(card.cwd)} && ${command}` : command;
}
export function filterBookmarks(cards: Bookmark[], group: string | null, cli: string, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => (group === null || (card.groupId ?? '') === group) && (!cli || card.cliId === cli)
    && words.every(word => [card.title, card.note, card.cwd, card.cliId, card.nativeSessionId].some(value => value?.toLocaleLowerCase().includes(word))));
}
