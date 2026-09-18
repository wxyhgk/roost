/** Pure CLI compatibility rules. No filesystem, process, network or terminal access. */
export type CliKind = "claude" | "codex" | "grok" | "qwen" | "opencode" | "omp";
export type CliAdapter = Readonly<{
  id: CliKind;
  name: string;
  imageStrategy: "bracketed-path";
  verifiedVersions: readonly string[];
}>;

const adapters: readonly CliAdapter[] = Object.freeze([
  { id: "qwen", name: "Qwen Code", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze(["0.21.14"]) },
  { id: "claude", name: "Claude Code", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]) },
  { id: "codex", name: "Codex", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]) },
  { id: "grok", name: "Grok", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]) },
  { id: "opencode", name: "OpenCode", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]) },
  /*
    omp 一直在 registry 里（它原生就发 OSC 777 那套事件），但**不在这张表里**，于是
    贴图走到 `getCliAdapter` 就是 unknown-cli：图片传上去了，插入那一步直接报「认不出
    这个 CLI」。

    它吃的就是同一份括号粘贴。18.1.18 的 `extractBracketedImagePastePaths` 要求整段以
    `ESC[200~` 开头、`ESC[201~` 结尾，路径要以 `/`、`~/`、`file://`、UNC 或盘符开头，
    扩展名匹配 `/\.(?:png|jpe?g|gif|webp)$/i`——和我们发出去的那一串逐条对得上。
  */
  { id: "omp", name: "Oh My Pi", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze(["18.1.18"]) },
].map(adapter => Object.freeze(adapter)) as CliAdapter[]);

export function listCliAdapters(): readonly CliAdapter[] { return adapters; }
export function getCliAdapter(id: string | null | undefined): CliAdapter | null {
  return adapters.find(adapter => adapter.id === id) ?? null;
}

function executableKind(command: string): CliKind | null {
  const path = command.replace(/\\/g, "/");
  const base = path.split("/").at(-1)?.replace(/\.(exe|cmd|bat)$/i, "");
  if (base === "claude-code") return "claude";
  if (getCliAdapter(base)) return base as CliKind;
  // Native installers use version-named executables.
  if (/\/(?:\.local\/share\/claude\/versions|\.claude\/local)\//.test(path)) return "claude";
  return null;
}

/** ps command strings are ambiguous: recognize executables/scripts, never prompt text. */
export function detectCli(commandLine: string): CliKind | null {
  const tokens = commandLine.match(/"[^"\n]*"|'[^'\n]*'|\S+/g)?.map(token => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const direct = executableKind(tokens[0] ?? "");
  if (direct) return direct;
  const executable = (tokens[0] ?? "").replace(/\\/g, "/").split("/").at(-1)?.replace(/\.exe$/i, "");
  if (executable !== "node" && executable !== "bun") return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (["-e", "--eval", "-p", "--print"].includes(token) || /^--(?:eval|print)=/.test(token)) return null;
    if (["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(token)) { i++; continue; }
    if (token.startsWith("-")) continue;
    const script = token.replace(/\\/g, "/");
    if (/\/@qwen-code\/qwen-code\/(?:cli(?:-entry)?\.js|bin\/qwen\.js)$/.test(script)) return "qwen";
    if (/\/@anthropic-ai\/claude-code\/cli\.js$/.test(script)) return "claude";
    if (/\/@openai\/codex\/bin\/codex\.js$/.test(script)) return "codex";
    if (/\/opencode-ai\/bin\/opencode$/.test(script)) return "opencode";
    return null;
  }
  return null;
}

export type ImageInsertion =
  | { kind: "unsupported"; reason: "unknown-cli" | "invalid-path" }
  | { kind: "paste"; cli: CliKind; strategy: "bracketed-path"; data: string;
      verification: "verified" | "unverified"; requiresConfirmation: boolean };

export function planImageInsertion(input: { cli: string | null; path: string; version?: string }): ImageInsertion {
  const adapter = getCliAdapter(input.cli);
  if (!adapter) return { kind: "unsupported", reason: "unknown-cli" };
  // Reject terminal control injection and relative paths before framing a paste.
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(input.path) || /[\x00-\x1f\x7f-\x9f]/.test(input.path)
    || !/\.(png|jpe?g|webp)$/i.test(input.path)) return { kind: "unsupported", reason: "invalid-path" };
  // Codex normalizes pasted paths with shlex. Keep whitespace, apostrophes and
  // backslashes inside one path token instead of relying on literal-path parsing.
  const payload = adapter.id === "codex" ? "'" + input.path.replace(/'/g, "'\\''") + "'" : input.path;
  // Recognized CLI image pastes insert automatically; verification is metadata,
  // not a confirmation gate. Callers still guard connection identity and omit Enter.
  const verified = input.version !== undefined && adapter.verifiedVersions.includes(input.version);
  return {
    kind: "paste", cli: adapter.id, strategy: adapter.imageStrategy,
    data: `\x1b[200~${payload}\x1b[201~`,
    verification: verified ? "verified" : "unverified", requiresConfirmation: false,
  };
}

export { DEFAULT_CLI_DEFINITIONS, detectConfiguredCli, resumeArgv, type CliDefinition, type CliResume, type CliRule, type CliId } from './registry.ts';
