# File editing API

`GET /api/file?root=...&path=...` returns `{ name, path, binary, truncated, content, mtime }`.
`mtime` is the file's `stat.mtimeMs` number; preserve its fractional part unchanged.
GET read failures use HTTP statuses: 400 missing fields or not a file,
403 escape/permission, 404 missing target, 500 other. `GET /api/fs` (listDir)
follows the same mapping with `fs error` fallback text.
The existing preview limit remains 8 MiB. The editor must disable saving when
`binary` or `truncated` is true to avoid saving an incomplete preview.

`PUT /api/file` accepts JSON `{ root, path, content, mtime }`. It edits an existing
regular file. `root` and `path` follow GET semantics; both lexical traversal and
symlinks leading outside the supplied root are rejected. Links inside the root
update the resolved target while preserving the link.

Responses:

- 200: `{ mtime }`. Replace the editor's saved revision with this value.
- 409: `{ message: "file changed", name, path, binary, truncated, content, mtime }`.
  Keep the user's unsaved buffer and offer comparison/reload. Conflict content is
  bounded to 8 MiB; honor `binary` and `truncated` here too. Do not automatically
  retry with the new mtime, which would overwrite the external edit.
- 400: missing/invalid fields or a non-regular file.
- 403: a path escapes the root or filesystem permission denies access.
- 404: the file no longer exists.
- 413: UTF-8 content or the existing file exceeds 8 MiB (8,388,608 bytes), or the
  encoded request exceeds 48 MiB + 64 KiB. JSON escaping does not reduce the content limit.
- 415: submitted content or the existing file contains a NUL byte.
- 500: another filesystem write error; leave the editor buffer unsaved.

The server serializes its saves per canonical file, checks mtime before staging,
scans the existing file for NUL bytes, writes an exclusive temporary file in the
same directory, preserves permission bits, fsyncs it, and checks the target's
identity/mtime/ctime/size again before rename. Ordinary failures remove the temp
file and leave the target intact. An abrupt process crash can leave a hidden
`.diy-save-*.tmp` file, but cannot expose a partially written target.

This is optimistic conflict detection: an independent process can still modify
the file between the final check and rename, or preserve its original mtime.
It is not an OS-level compare-and-swap operation. Atomic replacement changes the
inode and does not preserve hard-link relationships or extended attributes.

Allowed-origin preflights include PUT, PATCH and DELETE. External-change
WebSocket notifications are not part of this endpoint.

## File management API (`/api/fs` with a JSON body)

Same `root` traversal and symlink containment as above; `path` must be a
non-empty relative path. The workspace root itself can never be renamed or
deleted.

- `POST /api/fs` accepts `{ root, path, kind }` with `kind` of `"file"` or
  `"dir"`. Creates one file (exclusive, never overwrites) or one directory;
  intermediate directories must already exist. Slashes in `path` create
  nested entries. 201 returns `{ name, path }`.
- `PATCH /api/fs` accepts `{ root, path, newPath }` and renames within the
  same root. Never overwrites: an existing `newPath` is a 409. 200 returns
  `{ name, path }` with the new values; refresh any cached listing.
- `DELETE /api/fs` accepts `{ root, path }` and removes a file or a
  directory tree. 200 returns `{ ok: true }`.
- 400: missing/invalid fields, renaming/deleting the root, or a
  non-directory in the path.
- 403: a path escapes the root or filesystem permission denies access.
- 404: the target (or its parent) no longer exists.
- 409: the target already exists.
