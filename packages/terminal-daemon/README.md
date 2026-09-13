# @roost/terminal-daemon

The daemon owns `terminal-runtime` (PTYs, replay cursors, output persistence and
cwd/CLI scanning). The HTTP gateway owns workspace/API connections. Restarting
or killing the gateway does not dispose the daemon's runtime.

`openTerminalDaemon({dataDir,shell,defaultCwd})` starts a detached Node process
once or attaches to it. The returned client's `dispose()` only disconnects.
`startTerminalOwner` is an explicit lower-level factory; its `stop()` ends PTYs.
Imports alone start no processes. Unix-domain sockets are used (macOS/Linux).

A canonical data-directory hash selects a short socket path under `/tmp`.
A short-lived launcher orphans the owner before startup completes. `detached`
alone creates a process group but leaves the owner in the gateway's descendant
tree, where recursive cleanup tools such as concurrently/tree-kill can reach it.
A startup lock coordinates concurrent launchers. Live but incompatible or stalled
owners fail the handshake rather than being replaced. Socket messages use protocol
version 1, newline JSON, request IDs and bounded 4 MiB buffers. Request timeouts
close the connection; commands are never automatically resent. Inputs, resizes and
snapshots carry the expected terminal instance ID.

The client maintains live session metadata from ordered daemon state messages.
An IPC disconnect clears that cache and closes browser terminal connections;
it is not reported as a normal Shell exit. The client retries the existing socket.
If the daemon itself has exited, restarting the HTTP backend starts a new owner;
old PTYs cannot be recovered. There is no boot-time OS service registration yet.

Replay selection crosses an asynchronous boundary. The gateway subscribes first,
buffers bounded live events, sends the replay and then sends only output newer
than the replay sequence. Existing browser wire protocol v2 is unchanged.
Each gateway has its own SQLite connection; WAL and busy_timeout accommodate the
daemon's replay writes. Output retention limits from terminal-runtime still apply.

## Operations

From the repository root (same ROOST_DATA_DIR as the backend):

```
npm run daemon:status
npm run daemon:stop
```

Stopping the daemon terminates all its terminals. The log is
`<dataDir>/terminal-daemon.log`. The daemon keeps running when the last browser or
gateway disconnects. Changing runtime code, shell configuration or environment
requires deliberately stopping the daemon and starting the backend again.

First upgrade: a PTY already owned by the old HTTP process cannot be transferred.
Finish existing jobs before the first backend restart. Subsequent terminals use
the daemon and survive HTTP restarts. This change does not resurrect jobs after a
computer restart, daemon crash or explicit kill.

## Verification

`npm test --workspace @roost/terminal-daemon` starts concurrent clients and a real
isolated owner, verifies one owner PID, preserves terminal PID/instance/cursor and
collects output while all clients are disconnected. It cleans up its own daemon.

The package test command limits file-level concurrency to two. These integration
files each launch Node children, PTYs and IPC servers; starting every file at once
can exhaust short version-probe and startup deadlines. Root `npm run verify` uses
this same package command. Concurrency inside each test remains unchanged, as do
the assertions and production timeouts. Use the package command for the standard
gate; invoking `node --test tests/*.test.ts` directly omits this resource limit.

`backend/tests/daemon-restart.test.ts` starts actual HTTP child processes, creates
a real PTY through the API, then tests both SIGTERM and SIGKILL of the gateway.
It verifies the same PID/instance, cursor catchup, continued input and explicit
kill. No user sessions or model endpoints are used.

The owner test also verifies that the daemon is no longer a descendant of its
launching gateway, covering recursive process cleanup as well as direct signals.
