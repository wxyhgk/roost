# Stable backend core

The core is an independently installed terminal gateway. It connects to the
**existing** terminal daemon; it never creates a daemon, opens workspace SQLite,
runs migrations, or loads the business HTTP server. No frontend is included.

## Install and run

```
npm run core:install
npm run core:start
```

Build produces a bundled `core.mjs` with its protocol, WebSocket implementation
and daemon client. Build checks reject business backend/frontend, workspace-store,
terminal-runtime and node-pty inputs. Optional ws native accelerators are external
and not required; pure JS works without node_modules.

Install copies a content-addressed release under
`~/.roost/core/releases/<buildId>/`, validates it from an empty working
directory, then atomically updates `current`. `previous` retains the last release.
A failed build/install does not replace the current release. Installed files are
never overwritten; `core:start` resolves a release once before spawning it.

For a start independent even of the checkout's scripts, use the absolute command
printed during installation:

```
node ~/.roost/core/releases/<buildId>/core.mjs
```

It needs Node (tested here on 25.9.0), but no checkout, tsx, node_modules or frontend
build. Keep it outside the application's concurrently/watch process group.
`npm run core:rollback` selects the previous installed release for the next start.
Stopping/restarting only core-server disconnects its WebSockets; PTYs keep running.
No machine-login auto-start is configured in this first version.

Configuration:

- `CORE_PORT`: default 8788; `CORE_HOST`: 127.0.0.1 (or ::1).
- `ROOST_DATA_DIR`: selects the **same** canonical data directory as the
  existing daemon. It is used to locate the socket, not to open or migrate data.
- `CORE_SOCKET_PATH`: explicit existing daemon socket, useful for isolated tests.
- `CORE_ALLOWED_ORIGINS`: comma-separated exact additional browser origins.
- `CORE_INSTALL_DIR`: install/start/rollback scripts' release directory override.

Missing/incompatible daemon: the service remains reachable with disconnected
health, returns 503 for sessions, and retries. It never starts or replaces owner.
A daemon exit still ends its PTYs; core does not claim to restore a dead process.

## Frontend handoff

Default base: `http://127.0.0.1:8788`. The host must be loopback. Own origin and
http://localhost:5173 / http://127.0.0.1:5173 are allowed by default.
Do not proxy these endpoints through the development business backend.

### GET /api/core/health

HTTP 200 means core is alive; inspect `daemon.connected` separately:

```json
{"ok":true,"service":"core-server","buildId":"...","protocol":2,"daemon":{"connected":true,"ownerPid":123,"error":null},"capabilities":{"listSessions":true,"attachTerminal":true,"createSession":false,"killSession":false,"snapshot":false,"appearanceResponse":false}}
```

### GET /api/core/sessions

Returns `{sessions:[{id,cwd,cli,pid,instanceId}]}` for **all live** daemon sessions,
including sessions hidden by the main workspace. There is no project/title/closed
metadata, no database access and no record for an exited terminal. CLI values may
include opencode. Display cwd's last component or id as the label. 503 if daemon
is disconnected. Poll as needed; listing does not resize or write to a PTY.

### WS /api/core/pty?id=<encoded-session-id>

Missing id: HTTP 400, unknown live session: 404, daemon unavailable: 503,
untrusted Host/Origin: 403 before upgrade.

1. Receive normal v2 `hello` with pid, instanceId, cwd and cli; `opencode` is mapped
   to null on this existing v2 wire. Receive `appearance-owner: false`.
2. Send `{type:'ready',protocol:2,instanceId:<hello.instanceId>}` within 10 seconds.
   For same-instance cached output, include `afterSeq` (last fully applied seq).
   Ready does **not** resize the shared terminal, even if dimensions are supplied.
3. Wait until replay/catchup is applied, then enable input.
4. Send JSON `{type:'input',data:'...'}` and receive output/cwd/cli/exit frames.
   Binary frames are unsupported in this core contract.
5. Send `{type:'resize',cols:...,rows:...}` only on deliberate activation/resize.
   Dimensions are 1..1000. All clients share PTY dimensions; there is no global
   cross-gateway resize ownership in this version.

Subscribe-before-replay and seq filtering preserve the async replay boundary.
Input is bound to hello's instance; a replacement closes the old socket. Inputs
before ready or invalid messages close with 1008. Closing the page or core process
never kills a terminal. Daemon disconnect terminates client sockets for retry.

Core ignores snapshot/appearance-response messages. Frontend should disable those
features here, including automatic terminal color replies; the main gateway's
appearance-owner election is not shared with core. No new/kill/restart/delete,
file, note, attachment or project endpoints are exposed.

Outgoing WS buffers, queued input and replay-boundary events are bounded at 8 MiB.
Excessive backlog disconnects that socket without pausing the PTY. Replay remains
bounded by the daemon's retention limits; this is not an unlimited history archive.
The existing running daemon/client IPC can impose a smaller frame limit; core
cannot repair gaps already discarded by the daemon.

## Checks

`npm test --workspace @roost/core-server` uses temporary data directories and real
PTYs. It verifies unavailable-owner behavior, a late owner, JSON handshake,
read/write, reconnect cursor, core restarts preserving PTYs, ignored snapshots,
origin rejection and an independently deployed bundle with no business backend.

`npm run core:build` asserts deployment dependency boundaries. Typecheck and the
root source-boundary checks also cover this package. These tests do not touch
user terminals. Browser rendering and the stable frontend remain separate work.

### Installed standalone terminal workbench

The independent `stable-workbench/` entry is served on loopback port 8789 and
connects directly to 8788. `scripts/start-core.mjs` adds
`http://127.0.0.1:8789` and `http://localhost:8789` to the configured extra origins.
When running an installed core directly, set `CORE_ALLOWED_ORIGINS` explicitly to
include those origins (alongside any existing custom entries). See
`../../stable-workbench/README.md` for candidate installation and activation.

### 可选连接心跳

新版存活会话 `hello` 含 `heartbeat: 1`。客户端仅在该能力存在且回放已应用后，每 15 秒发送 `{ "type": "ping", "nonce": 1 }`（nonce 为递增非负安全整数）；网关回复相同 nonce 的 `pong`，不向 PTY 写入。前台约 10 秒无对应应答可重建 WebSocket，并沿用最后已解析的输出游标。后台或休眠造成计时器明显延迟时，重新探测，不能用“终端没有输出”推断断线。未宣告能力的旧网关保持原连接行为；新网关也接受不发送心跳的旧客户端。安装目录中的旧基座需单独升级后才支持该能力，无需修改 daemon 协议。
