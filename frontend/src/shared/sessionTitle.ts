import type { Session } from './types';
import { basename } from './path';
import { t } from "@roost/i18n";

/** Default and legacy numbered titles follow the current working directory. */
export function sessionTitle(session: Pick<Session, 'title' | 'cwd'>): string {
  if (session.title && session.title !== 'Terminal' && !/^Session \d+$/.test(session.title)) return session.title;
  return basename(session.cwd) || session.cwd || t.misc.session.fallbackTitle;
}
