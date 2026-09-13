# @roost/cli-adapters

Browser-safe, side-effect-free CLI compatibility rules. Owns the full `CliKind`
union, executable recognition, adapter metadata and image insertion plans. It
neither reads files nor starts processes, uploads images or writes PTY input.

```ts
import { detectCli, listCliAdapters, planImageInsertion } from '@roost/cli-adapters';

const cli = detectCli('/usr/bin/node /opt/node_modules/@qwen-code/qwen-code/cli.js');
const plan = planImageInsertion({ cli, path: '/absolute/image.png', version: '0.21.14' });
if (plan.kind === 'paste') {
  // Caller checks the original session/instance/connection before insertion.
  // sendInput(plan.data); // one bracketed paste, no Enter
}
```

All five registered CLI adapters currently use the same candidate `bracketed-path`
strategy. Only Qwen 0.21.14 passed the local PTY-to-model-payload smoke. Other CLI
entries and unknown/new versions return `verification: "unverified"`. Recognized
CLIs return `requiresConfirmation: false` to allow automatic insertion after upload. A strategy describes an insertion attempt, not a
promise of model vision support. Verified means transport reached a mock model
as image data; it does not certify a real model's visual understanding.

Unknown CLIs produce an unsupported plan, and no input. Paths must be absolute,
have a supported image extension, and contain no terminal control characters.
The caller remains responsible for filesystem access, permissions and existence.

`detectCli` only recognizes executable names and known Node/Bun launcher paths.
It does not search arbitrary prompt text for CLI names. Process table parsing and
process-tree traversal remain in terminal-runtime. `ps` recognition is heuristic;
it does not establish which nested application currently has input focus, nor
infer a binary's version. Backend uploads therefore do not auto-send the plan.

To add a CLI: update this package's kind/metadata and recognition rules, use the
shared strategy unless there is a demonstrated difference, add tests, and record
verified versions only after a real CLI transport smoke. Do not add per-CLI
upload endpoints or duplicate the attachment store. No automatic version probing
is done: launching installed binaries just to infer capabilities can have side effects.

## Integration

- terminal-runtime depends on this package for recognition and internal CLI types.
- terminal-protocol derives its existing v2 client CLI enum from this package,
  excluding OpenCode until the frontend can render it safely.
- backend maps OpenCode to `null` on v2 workspace/hello/cli payloads. Internally it
  is recognized, and its image insertion plan is available on upload responses.
- `GET /api/cli-adapters` returns the registry. Clients can consume this HTTP API
  without adding a package dependency, or declare the package when adopting it.
- Attachment uploads add `insertion: ImageInsertion` to the existing response.
  The frontend automatically inserts recognized CLI plans after checking the
  original session, instance and connection. It never appends Enter.

The frontend currently owns a four-entry logo table and is maintained separately.
Once it supports OpenCode or unknown CLI fallback, expand the protocol enum and
remove the backend v2 presentation mapping together. Do not emit an unrecognized
CLI identifier to the existing client: its logo renderer would throw.

Checks: `npm test --workspace @roost/cli-adapters`, package typecheck, workspace
boundary checks, and optional `node --import tsx scripts/smoke-qwen-attachments.mjs`.

## Codex path parsing

Codex 0.153.4 `normalize_pasted_path` uses shell tokenization for POSIX paths.
The shared bracketed-paste transport now quotes the Codex path, escaping embedded
apostrophes, so directories such as `Application Support` stay one token. Other
adapters retain their literal path payload. Consumers must use `plan.data` rather
than reconstructing the payload from `attachment.path`.

Evidence: upstream `rust-v0.153.4`, `codex-rs/tui/src/clipboard_paste.rs` and
`bottom_pane/chat_composer.rs`. The parser regression round-trips whitespace,
apostrophes and backslashes through Python 3 shlex (Python 3 is required for this
test). This is not a completed Codex PTY-to-model smoke; Codex remains unverified.
User feedback reports OpenCode, Grok and Claude working, without exact versions
or captured model payloads; no verified-version entries were inferred from it.
