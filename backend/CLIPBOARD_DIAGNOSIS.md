# Why image Cmd+V is silent in Codex

Verified on 2026-09-06 using Edge and an isolated page mounting the project's
actual `frontend/src/terminal/xtermEngine.ts`. No existing user terminal received
test input, and no model request was submitted.

## Observed browser-to-terminal data

For an image-only browser clipboard, Command+V produced:

```json
{"event":"paste","types":["Files"],"textLength":0}
{"event":"pty-input","data":"\u001b[200~\u001b[201~"}
```

For a text clipboard, it produced:

```json
{"event":"paste","types":["text/plain"],"textLength":16}
{"event":"pty-input","data":"\u001b[200~paste-probe-text\u001b[201~"}
```

Installed xterm's `src/browser/Clipboard.ts` reads only
`clipboardData.getData('text/plain')`, then frames that text as bracketed paste.
Before this fix, the frontend had no image paste capture/upload handler. The
ClipboardAddon alone is not the application's HTTP image upload integration.

## CLI handling differs at empty paste

- Installed Qwen 0.21.14: its keypress handler calls `clipboardHasImage` when the
  bracketed paste buffer is empty, then marks the event `pasteImage` and lets its
  input prompt save the host clipboard image.
- OpenCode development source: prompt `onPaste` dispatches `prompt.paste` when
  trimmed text is empty; that command reads the clipboard and handles image MIME.
  This is source evidence, not a reproduction of the installed OpenCode version.
- Codex rust-v0.153.4: `ChatComposer::handle_paste` attempts image-path parsing
  only when the character count is greater than one. Empty paste inserts empty
  text. The path branch itself supports real image files and shell-quoted paths.
- Claude and Grok were reported working by the user. Their exact empty-paste
  behavior was not independently reproduced during this browser investigation.

Sources:
- https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/chat_composer.rs
- https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/clipboard_paste.rs
- https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/prompt/index.tsx

## Implemented fix and validation

`frontend/src/terminal/imagePaste.ts` captures image clipboard items before
xterm, uploads them to the attachments API and displays a preview. Automatic
insertion uses the shared CLI adapter after validating the session, instance and
connection epoch. No Enter is sent. Ordinary text paste remains unchanged.

Browser validation mounted the actual `TermView` against an isolated backend
and real shell PTY. Command+V with a synthetic PNG showed the upload preview and
confirmation (the initial implementation). Before confirmation no terminal input was sent; clicking “插入图片”
sent exactly one bracketed paste containing the quoted uploaded path, with no
trailing Enter. The isolated fixture reported Codex for adapter selection; it did
not run the actual Codex CLI or test a model's image understanding. Existing user
terminals were untouched and the clipboard was restored after testing.

Frontend tests cover text passthrough, confirmation and quoting, canceled/late
uploads, connection changes, invalid inputs and retry after upload failure.
See ATTACHMENTS_API.md for the endpoint contract and usage.

Do not fix this by making the backend read its OS clipboard: browser and backend
may be on different machines, so the host clipboard could contain another image.
Codex-specific path quoting is a separate valid fix for filenames with spaces;
it does not address image-only empty paste.

The subsequent automatic-insertion change removes the confirmation step for
recognized CLI plans. Regression tests check exactly one paste without Enter,
no input before upload completion, and no insertion after cancel or reconnect.
