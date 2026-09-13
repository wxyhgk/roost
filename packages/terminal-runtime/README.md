# @roost/terminal-runtime

PTY ownership and bounded replay, created through `createTerminalRuntime`.
Storage is injected; transport and frontend code stay outside this package.

## Mouse mode recovery

The running PTY's mouse modes are tracked separately from retained output.
On replay or cursor catchup, the backend restores the live modes even when
an initial enable command was evicted or a browser snapshot omitted it.
Snapshot content does not decide the live mode when the PTY has reported one.

Restoration is emitted only at an ANSI parser boundary. If a reconnect occurs
inside a partial CSI, OSC, DCS, or escape sequence, restoration is deferred
until that sequence finishes or is cancelled. The repair travels in the next
numbered output chunk, so all connected clients and later snapshots see the
same bytes. Original PTY bytes and sequence order are preserved.

Mode tracking starts fresh for each new PTY. Persisted history cannot turn on
an old process's mouse mode in a new shell. This feature restores terminal
input routing; it does not move a CLI's own scroll position or preserve a
process across backend restarts.

Run `npm test --workspace @roost/terminal-runtime` and backend integration tests
with `npm test --workspace backend` from the repository root.

## History storage failures

Background writes catch storage failures and retain dirty history in bounded memory.
Retries back off from 3 seconds after the first failure to at most 30 seconds;
new PTY output does not create additional retry timers. A first failure and recovery
are logged using the session ID, without terminal contents or raw storage errors.

Natural exit still emits its exit event. Unsaved history can retry after exit;
if the same session is reopened first, its new PTY takes over the retained history.
Each session is flushed independently. On shutdown all PTYs/listeners/timers are
released even if persistence fails; any final unsaved history is explicitly reported.
Memory retention is not durability: persistent storage failure followed by shutdown
can still lose the unsaved tail. `flush()` returns a success boolean for callers.
