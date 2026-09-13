# Clipboard image attachments

## Upload

`POST /api/sessions/:id/attachments`, multipart form data:

- `file`: exactly one PNG/JPEG/WebP image file.
- `instanceId`: the current terminal instance ID from the WebSocket `hello` message.

Use `FormData` and let the browser set Content-Type with its boundary. Do not
base64-encode the file or send it through the terminal WebSocket.

201 response:

```json
{
  "id": "random-uuid",
  "name": "random-uuid.png",
  "path": "/absolute/application-data/attachments/session-hash/random-uuid.png",
  "mime": "image/png",
  "size": 123456,
  "width": 1920,
  "height": 1080,
  "sessionId": "session-id",
  "instanceId": "terminal-instance-id"
}
```

The backend preserves the original bytes, derives the extension and MIME from
validated image data, and ignores the uploaded filename for disk paths. Limits:
10 MiB per file, 10 MiB + 64 KiB total request, 25 million pixels, two concurrent
uploads per backend instance, and 30 seconds to receive a request. Animated
images are currently rejected. Header signatures plus a full sharp decode
validate the image; corrupt/truncated images are rejected.

Failures return JSON `{ message }`: 400 malformed form/extra fields, 403 forbidden
origin or attachment directory, 404 missing session, 408 upload timeout, 409
closed/exited/replaced terminal, 413 byte limit, 415 unsupported/invalid image,
429 concurrent upload limit, 500 storage failure, 503 storage not configured.
The common access guard can return a plain-text 403 before the route executes.

## Browser clipboard integration

Implemented in `frontend/src/terminal/imagePaste.ts`, connected by `useTerminal`
and displayed by `TermView`:

1. Focus the AI terminal and press Command+V with an image on the clipboard.
2. The browser captures image clipboard items before xterm, uploads the image,
   and displays a thumbnail with upload/error status. Ordinary text paste remains
   on xterm's existing input path.
3. After upload, the image reference is automatically inserted into the detected CLI. The
   frontend uses `@roost/cli-adapters` to generate the bracketed paste, including
   Codex path quoting. No Enter is appended; add a prompt and submit yourself.

One PNG/JPEG/WebP image up to 10 MiB can be pending at a time. Cancel aborts
an in-progress request and clears the preview. Changing tabs cancels pending
insertion; disconnecting, replacing the terminal or changing the detected CLI
invalidates it. A delayed response must match the captured session, instance and
connection epoch. The backend also checks the instance before/after saving.

Recognized CLI plans insert automatically, even when version detection is unavailable.
Unknown CLI detection shows a visible error instead of inserting into a shell.
The browser never reads or overwrites the backend machine's OS clipboard.

## Persistence and scope

Production storage is `<ROOST_DATA_DIR>/attachments` (default
`~/.roost/attachments`). Session subdirectories use a hash of the ID,
files use random UUID names and mode 0600, directories are created with mode 0700.
Writes stage and fsync a temporary file before rename. No filename/path from the
client selects the destination. Uploads never write terminal input or launch a CLI.

Attachments survive disconnects, backend restarts, session closure and deletion.
Usage, listing and explicit deletion APIs are available below. Automatic cleanup
and total disk quotas are not implemented; storage grows until explicitly cleaned. Do not remove files
merely because a WebSocket disconnected: the CLI may still reference them.
An interrupted client may leave a successfully saved but unreferenced attachment.
There is no thumbnail-serving endpoint; the browser can preview its original Blob.

This path handoff assumes the CLI shares the backend filesystem. Remote/container
CLIs with a different filesystem require a separate upload/mount adapter. Upload
support does not grant model vision capability; that depends on the CLI's selected
model/provider.

## Validation

Backend tests: `npm test --workspace backend`.

Optional integration smoke (requires `qwen` on PATH):

```sh
node --import tsx scripts/smoke-qwen-attachments.mjs
```

The smoke uses an isolated QWEN_HOME/runtime directory, a real PTY/WebSocket and
an isolated backend. It uploads a synthetic red image, pastes the returned path
into Qwen, confirms Qwen creates a clipboard attachment, and submits a prompt to
a local mock model endpoint. The mock decodes the actual image_url payload and
checks its dimensions and red pixels. It does not test a real model's visual
understanding, use user credentials, or interact with existing user terminals.
Qwen may convert PNG to JPEG when preparing its model request; verify decoded
pixels rather than requiring the outgoing MIME/bytes to equal the uploaded file.

With installed Qwen 0.21.14, the custom test model needed
`generationConfig.modalities.image: true` in its modelProviders entry;
`capabilities.vision: true` alone still caused the image to be replaced by a
text-only unsupported-image notice. Only declare image input for a provider/model
that actually supports it. No user Qwen configuration is changed by the smoke.

## Shared CLI adapter plans

The upload response now also includes `insertion`, generated by
`@roost/cli-adapters` using the runtime's detected CLI. It is either:

- `{ kind: "unsupported", reason: "unknown-cli" | "invalid-path" }`, or
- `{ kind: "paste", cli, strategy: "bracketed-path", data, verification,
  requiresConfirmation }`.

Use the shared plan after checking the captured session/instance/connection;
do not implement a separate escape sequence per CLI. Honor `requiresConfirmation`.
The browser regenerates the plan from the returned CLI and path using the same
package, so updated quoting also works with an already-running older backend.
The backend does not know the binary version, so its generated paste plans are
unverified, but allow automatic insertion for recognized CLIs. Unknown CLI detection leaves
the upload available but generates no automatic insertion text. The backend never
sends input on the user's behalf. A verified transport strategy still requires an
image-capable model and provider configuration.

`GET /api/cli-adapters` returns `{ adapters }`, listing Qwen, Claude, Codex, Grok
and OpenCode, their candidate strategy and explicitly verified versions. This
endpoint uses the same Host/Origin policy as other APIs. OpenCode is internally
recognized but remains a generic terminal in the existing v2 client messages
until the separately owned frontend supports its identifier.

Codex paths need shell quoting when pasted (including paths with spaces). The
adapter now applies that quoting. Use `insertion.data` verbatim rather than
wrapping `attachment.path` yourself. Manual Qwen path framing is not a universal
implementation for all CLIs.

## Usage and manual cleanup

Storage implementation lives in `@roost/attachment-store`; backend routes only
add workspace labels and live-terminal checks. Existing uploads need no migration:
the catalog discovers managed UUID image files in hashed session directories.

- `GET /api/attachments` returns `{count, bytes, sessions}`. Each session group has
  `{sessionKey, count, bytes, sessionId, title, running}`. Deleted workspace sessions
  remain visible as groups with `sessionId: null` and `title: null`.
- `GET /api/attachments/:sessionKey` returns `{files:[{name,size,mtime}]}`.
- `DELETE /api/attachments/:sessionKey/:name` explicitly deletes one managed file
  and returns `{deleted,bytes}`. There is no implicit session-wide delete.

`sessionKey` is the hash returned by the catalog, not a user-selected disk path.
Deletion returns 409 if the owning terminal is running (including hidden sessions)
or an upload is pending; 400 for invalid key/name; 403 for symlinks/non-files;
404 for a missing file. Unsupported files and temporary files are not cataloged.
Closing a tab, hiding a session, disconnecting or killing a session never performs
automatic attachment deletion. A deleted session's attachments can be cleaned
through its retained sessionKey after reviewing the listing.

No frontend management panel is included. A future panel should show space used,
list the selected group's attachments and ask before calling DELETE. The backend
does not track references in other CLI histories or other applications: explicit
cleanup can invalidate those references. The running-session guard assumes the
normal single HTTP gateway deployment; cleanup is not a distributed lease across
multiple independently running gateways.
