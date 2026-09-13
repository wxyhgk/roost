import type { DatabaseSync } from 'node:sqlite';
import { createLibraryRecords } from './library-records.ts';
export const createSnippets = (db:DatabaseSync) => createLibraryRecords(db,'snippets');
