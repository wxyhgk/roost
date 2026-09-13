# History archive API

Append-only per-session terminal history on disk, separate from the bounded
replay used for reconnects. The daemon runtime emits every output chunk;
the server subscribes each live session and archives `{ seq, data }` keyed by
sequence number, so redelivery is idempotent. Killing a session deletes its
archive; closing (hide) keeps archiving while the process runs.

Storage: `<dataDir>/history/<sessionId>/<seq padded to 12>.log`, one file per
output chunk. Rotation keeps 256 MiB per session by deleting the oldest chunk
files (checked at most every 128 appends). Session IDs outside
`[A-Za-z0-9_-]{1,64}` are rejected; anything else (paths, `..`) never reaches
the filesystem.

`GET /api/sessions/:id/history?before=<seq>&bytes=<n>` returns
`{ seqs, hasMore, fromStart, text, totalBytes }`: the newest chunks below
`before` (default: latest) up to `bytes` (default 65536, max 1048576).
`text` is ANSI-stripped **after** concatenation so sequences split across
chunks still match; a dangling trailing ESC is dropped. `hasMore` means older
chunks exist; `fromStart` means the oldest chunk is included, so the viewer
keeps the first partial line only then.

`GET /api/sessions/:id/history/search?q=...&limit=...` returns
`{ total, matches: [{ line, text }] }`: case-insensitive substring over the
stripped stream with 1-based global line numbers, `text` capped at 500 chars,
`total` untruncated by `limit` (default/max 200). Empty or >200-char queries
return no matches.

`GET /api/sessions/:id/history/download` streams the raw concatenated bytes
(with ANSI escapes) as `terminal-<id>.log` attachment.

Unknown session: 404. Missing archive backend: 503. Invalid cursor: 400.
