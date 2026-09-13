import type { DatabaseSync } from 'node:sqlite';
import { createLibraryRecords } from './library-records.ts';
export const createNotes = (db:DatabaseSync) => createLibraryRecords(db,'notes');
