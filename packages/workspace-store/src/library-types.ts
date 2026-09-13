export type LibraryKind = 'notes' | 'snippets';
export type LibraryBase = {id:string;revision:number;createdAt:number;updatedAt:number;deletedAt:number|null};
export type NoteRecord = LibraryBase & {text:string};
export type SnippetRecord = LibraryBase & {title:string;lang:string;code:string};
export type LibraryRecord = NoteRecord | SnippetRecord;
export type LibraryFields = {text?:string;title?:string;lang?:string;code?:string};
export type LibraryListItem = Pick<LibraryBase,'id'|'revision'|'createdAt'|'updatedAt'> & {title:string;summary:string;lang?:string};
export type LibraryPosition = {updatedAt:number;id:string};
export class LibraryError extends Error {
  readonly status:number;
  readonly code:string;
  readonly current?:unknown;
  constructor(status:number, code:string, message:string, current?:unknown) {
    super(message);this.name='LibraryError';this.status=status;this.code=code;this.current=current;
  }
}
