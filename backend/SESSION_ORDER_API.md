# Session ordering

`PATCH /api/sessions/:id` accepts `{ projectId?, title?, beforeId? }`.

- Omit `beforeId`: preserve the current order (existing clients are unchanged).
- String `beforeId`: move the session immediately before that session.
- `beforeId: null`: move to the global end.
- `beforeId === id`: ordering is an idempotent no-op; other supplied fields retain their PATCH semantics.

Success returns 200 with the updated session record, not the workspace. Fetch
`GET /api/workspace` for the new `sessions` array order. Clients should preserve
that order when filtering/grouping by project; do not sort it again.

Missing moved session: 404. Missing target or a non-string/non-null `beforeId`:
400. Invalid targets are rejected before changing title or project membership.

The store reads all sessions ordered by `seq`, including closed sessions, removes
and reinserts the moved ID, then writes integer `seq` values 1..N in a single
transaction. No migration or new columns. Self-moves do not rewrite sequences.
The existing creation counter remains unchanged; newly created sessions append.

Regression coverage: `backend/tests/session-order.test.ts`, including persisted
order, closed sessions, legacy PATCH behavior and rollback on a failed seq update.
