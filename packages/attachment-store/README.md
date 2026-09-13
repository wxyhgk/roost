# @roost/attachment-store

Owns multipart image validation, private atomic storage, per-session upload limits,
managed file discovery, byte/count statistics and explicit deletion. No workspace,
terminal runtime or HTTP router dependency; importing starts no I/O.

`createAttachmentStore({directory})` exposes `receive`, `sessionKey`, `usage`,
`list` and `remove`. The gateway supplies instance validity for upload and a
live-terminal guard for deletion. Uploading blocks deletion in the same store.
Only UUID PNG/JPEG/WebP files in hash-named directories are managed; no filesystem
path from a request selects an arbitrary destination. Listing and deletion reject
symlinks. Existing uploaded files need no database migration.

There is no automatic cleanup or cross-session reference tracking. Removing a file
is an explicit user operation and may invalidate old CLI history references.
The backend integration tests cover decoding, persistence, quotas on individual
uploads, usage, orphaned session discovery, hidden live session protection and
symlink rejection. API contract: `backend/ATTACHMENTS_API.md`.
