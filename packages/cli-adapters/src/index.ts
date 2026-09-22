/** Pure CLI compatibility rules. No filesystem, process, network or terminal access. */
export type CliKind = "claude" | "codex" | "grok" | "qwen" | "opencode" | "omp";
export type CliAdapter = Readonly<{
  id: CliKind;
  name: string;
  imageStrategy: "bracketed-path";
  verifiedVersions: readonly string[];
  /**
   * 「只清空输入框、不碰正在跑的那一轮」是哪个键。
   *
   * 有这一项，宿主才敢把运行中的第一下 Ctrl+C 改成「先清空」；**没有就什么都不做**，
   * Ctrl+C 原样发下去。猜一个键的代价不对称：猜对了省一次误打断，猜错了就是往一个
   * 正在跑的 agent 里塞一个谁也不知道会触发什么的控制字符。
   *
   * 每一个都是在真 PTY 里量出来的：打一串字 → 按这个键 → 再打一串，
   * 看最后那一行是不是只剩后一串。没量过的（codex 是整屏重绘，这个法子看不出来；
   * qwen、grok 本机没装）一律留空。
   */
  clearInputKey?: string;
  /**
   * 把**多行**文本括号粘贴进输入框，会发生什么。**没量过的一律留空**，和 `clearInputKey`
   * 同一条纪律，理由也一样：代价不对称。
   *
   * 贴图走的是同一条括号粘贴，但那是**单行**。多行的失败模式完全不同——如果一个 TUI 把
   * 粘贴内容里的 `\r` 当成回车键，一段 N 行的文本就是 N 次提交，把人写了一半的话连发
   * 好几条，**收不回来**。所以这里不复用 `imageStrategy`，必须单独量。
   *
   * - `literal`   —— N 行原样躺进输入框，不提交
   * - `collapsed` —— 不提交，但折叠成一个占位符（内容留着，用户看不见原文）
   *
   * 量法：真 PTY 里起这个 CLI，送 `ESC[200~ 行1 CR 行2 CR 行3 ESC[201~`，**之后不按任何键**，
   * 用 @xterm/headless 重建屏幕看三行在哪。2026-09-21 实测：
   *
   * - claude 2.1.278 → literal（中文、全角括号、``` 围栏都完好）
   * - omp 18.1.18 → literal（末行尾那个多出来的字符是它的行内补全提示，不是内容被改）
   * - opencode 1.18.31 → collapsed（显示成 `[Pasted ~3 lines]`）
   * - codex 0.154.0 → literal。**这一条不是探针量的，是人工验的**：`codex login status` 在
   *   本机是 "Not logged in"，探针一起来就落进 OAuth 登录流程，进不到输入框。所以由使用者
   *   在真界面里试了一遍，确认没有被自动发出去。来源不同，照实记。
   */
  multilinePaste?: "literal" | "collapsed";
}>;

/** readline 的 kill-line。上面三家实测都是它。 */
const CTRL_U = "\u0015";

const adapters: readonly CliAdapter[] = Object.freeze([
  { id: "qwen", name: "Qwen Code", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze(["0.21.14"]) },
  { id: "claude", name: "Claude Code", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]), clearInputKey: CTRL_U, multilinePaste: "literal" },
  { id: "codex", name: "Codex", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]), multilinePaste: "literal" },
  { id: "grok", name: "Grok", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]) },
  { id: "opencode", name: "OpenCode", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze([]), clearInputKey: CTRL_U, multilinePaste: "collapsed" },
  /*
    omp 一直在 registry 里（它原生就发 OSC 777 那套事件），但**不在这张表里**，于是
    贴图走到 `getCliAdapter` 就是 unknown-cli：图片传上去了，插入那一步直接报「认不出
    这个 CLI」。

    它吃的就是同一份括号粘贴。18.1.18 的 `extractBracketedImagePastePaths` 要求整段以
    `ESC[200~` 开头、`ESC[201~` 结尾，路径要以 `/`、`~/`、`file://`、UNC 或盘符开头，
    扩展名匹配 `/\.(?:png|jpe?g|gif|webp)$/i`——和我们发出去的那一串逐条对得上。
  */
  { id: "omp", name: "Oh My Pi", imageStrategy: "bracketed-path", verifiedVersions: Object.freeze(["18.1.18"]), clearInputKey: CTRL_U, multilinePaste: "literal" },
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

/** 围栏至少三个反引号；内容里已经有更长的连续反引号时要比它再长一个（CommonMark 的规则）。 */
export function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

export type TextInsertion =
  | { kind: "unsupported"; reason: "unknown-cli" | "unmeasured-cli" | "empty" }
  | { kind: "paste"; cli: CliKind; data: string; lines: number;
      /** 用户会看到原文，还是一个占位符。界面据此决定要不要多说一句。 */
      presentation: "literal" | "collapsed" };

/**
 * 把一段选中的文本插进 CLI 的输入框，**不提交**。
 *
 * 和 `planImageInsertion` 同一条路（括号粘贴、不带回车），但多了三件事：
 *
 * 1. **只认量过的 CLI**（`multilinePaste`）。没量过就不做——见那个字段的注释。
 * 2. **剥掉所有 C0/C1 控制字符。** 这不只是卫生问题，是**注入防护**：内容里如果混进一个
 *    真正的 `ESC`，后面跟 `[201~` 就会提前结束这次括号粘贴，剩下的字节会被 TUI 当**按键**
 *    处理。终端屏幕上本来不该出现裸 ESC（它被解析器吃掉了），但这条路的输入来自选区，
 *    不值得赌。
 * 3. **换行统一成 `\r`。** xterm 的选区给的是 `\n`，而真实终端粘贴发的是 `\r`，TUI 的
 *    括号粘贴解析器认的也是 `\r`。
 */
export function planTextInsertion(input: { cli: string | null; text: string; fenced?: boolean }): TextInsertion {
  const adapter = getCliAdapter(input.cli);
  if (!adapter) return { kind: "unsupported", reason: "unknown-cli" };
  if (!adapter.multilinePaste) return { kind: "unsupported", reason: "unmeasured-cli" };
  const lines = input.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // 控制字符已经不含 \n 了（上一步切掉了），所以这里剥干净是安全的。
    .map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return { kind: "unsupported", reason: "empty" };
  const body = input.fenced === false ? lines : [fenceFor(lines.join("\n")), ...lines, fenceFor(lines.join("\n"))];
  return {
    kind: "paste", cli: adapter.id, lines: lines.length,
    presentation: adapter.multilinePaste,
    // 不带回车：塞进输入框，按不按发送由人决定。
    data: `\x1b[200~${body.join("\r")}\x1b[201~`,
  };
}

export { DEFAULT_CLI_DEFINITIONS, detectConfiguredCli, resumeArgv, type CliDefinition, type CliResume, type CliRule, type CliId } from './registry.ts';
