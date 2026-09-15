import type { Block } from "../parts";

/**
 * 认出「这次调用的是哪个工具」，以及「参数里到底有什么」。
 *
 * 分成独立的一层、而且不含 JSX，是因为这一层的每条规则都测得到，而混进组件就测不到——
 * 和 `parts.ts` 顶上那条理由是同一条。`frontend/tests/` 没有 jsdom，能测的东西必须先挤成
 * 纯函数。
 */

export type ToolId = {
  /** MCP 工具的服务器名。不是 MCP 就是 null。 */
  server: string | null;
  /** 工具本身的名字，MCP 的已经把前缀剥掉了。 */
  tool: string;
  /** 匹配用的键：小写。渲染器拿它对号入座。 */
  key: string;
};

/*
  各家 CLI 写进 `part.name` 的是**原始字符串**，没有任何一处做过归一化（解析器见
  `packages/ai-transcript/src/`）。于是同一件事有好几个名字：Claude 写 `Edit`，opencode 写
  `edit`，codex 写 `apply_patch`。不对齐的话，注册表得为每个拼写各写一条，而漏掉一条的症状是
  「这个工具在某个 CLI 下就是不走专用视图」——不会报错，只会悄悄退回原样。

  这张历史名对照表照搬自 happier（MIT，happier-dev/happier，
  apps/ui/sources/components/tools/normalization/policy/normalizeToolNameForView.ts），
  只留了和我们数据对得上的条目。
*/
const ALIASES: Record<string, string> = {
  // 带厂商前缀的历史名。
  codexbash: "bash",
  codexpatch: "patch",
  codexdiff: "diff",
  // 各家对同一件事的不同叫法。
  shell: "bash",
  execute: "bash",
  run_terminal_cmd: "bash",
  apply_patch: "patch",
  str_replace_editor: "edit",
  view: "read",
  remove: "delete",
  search: "grep",
};

/**
 * 工具名 → 可匹配的身份。
 *
 * **MCP 工具必须拆开。** Claude 把整串 `mcp__<服务器>__<工具>` 原样写进 name（我们自己的
 * agent-messaging 注册的是短名 `agent_send`，到了 transcript 里变成
 * `mcp__workspace_messaging__agent_send`）。不拆的话它永远匹配不到任何渲染器，而拆开之后
 * 「所有 MCP 工具」可以由一个渲染器统一接管。
 *
 * 空名是**真实情况**不是异常：配不上调用的孤儿结果，`parts.ts` 给的 name 就是空串。
 */
export function identifyTool(name: string): ToolId {
  const raw = name.trim();
  if (raw.startsWith("mcp__")) {
    const parts = raw.slice("mcp__".length).split("__");
    // `mcp__a__b__c`：服务器名是第一段，剩下的原样拼回去当工具名。
    const server = parts[0] ?? "";
    const tool = parts.slice(1).join("__");
    return { server: server || null, tool, key: "mcp" };
  }
  const lower = raw.toLowerCase();
  const tool = ALIASES[lower] ?? lower;
  return { server: null, tool, key: tool };
}

export type ToolArgs = {
  /** 参数原文。永远有，哪怕是空串。 */
  raw: string;
  /**
   * 解析出来的参数对象，解不出就是 null。
   *
   * **新数据基本都解得出，老数据基本都解不出。** 解析器现在按结构深度截断
   * （`packages/ai-transcript/src/truncate.ts`），七家一致地存可解析的 JSON；而在那之前
   * Claude / qwen / omp 是把整个参数对象压成 `command ?? file_path ?? path` 一个标量值的，
   * 那些记录已经写进库里，压掉的字段回不来了。
   *
   * 所以同一条对话里新旧会混着，渲染器**不能假设 json 存在**——拿不到就得靠 raw 顶着。
   */
  json: Record<string, unknown> | null;
};

export function toolArgsOf(block: Extract<Block, { kind: "tool" }>): ToolArgs {
  const raw = block.args;
  if (!raw) return { raw: "", json: null };
  const trimmed = raw.trim();
  // 只有对象才算参数。数组和标量解出来也没有字段可读，当没解出来处理更省事。
  if (!trimmed.startsWith("{")) return { raw, json: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { raw, json: null };
    return { raw, json: parsed as Record<string, unknown> };
  } catch {
    return { raw, json: null };
  }
}

/** 从参数里取一个字符串字段，按给定的别名顺序找第一个有值的。 */
export function argString(args: ToolArgs, ...keys: string[]): string | null {
  if (!args.json) return null;
  for (const key of keys) {
    const value = args.json[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * 这次调用最能代表它的那个「主语」：命令、文件路径、或者随便什么参数原文。
 *
 * 老数据里 Claude 只留一个标量，那个标量**恰好就是**命令或路径（当时的解析器按
 * `command ?? file_path ?? path` 的顺序挑的），所以 raw 本身就是主语；新数据是结构化 JSON，
 * 走上面那条按字段取的路。两条都要留着，因为库里两种记录同时存在。
 */
export function toolSubject(args: ToolArgs): string | null {
  /*
    `pattern` 排在 `path` 前面是有讲究的：Grep 和 Glob 两个字段都带，而它们的主语是模式不是
    目录——「在 /src 里搜」远不如「搜 TODO」有信息量。反过来 LS 只有 path、Read 只有
    file_path，谁都不会被这个顺序抢走。`command` 始终第一，所以 Bash 不受影响。
  */
  return argString(args, "command", "file_path", "filePath", "pattern", "path", "url")
    ?? (args.json ? null : args.raw || null);
}

/*
  k=v 摘要的三道上限。数字照搬 happier（MIT，happier-dev/happier，
  apps/ui/sources/components/tools/renderers/system/UnknownToolView.tsx 的 `formatSubtitle`）：
  它那一行和我们这一行是同一个位置、同一个用途，没有理由自己另拍一组。

  三道都是必需的，少一道就还是会糊成一坨：只限总长的话，第一个键的长文本就能把预算吃光，
  后面的键一个都轮不到；只限单值的话，键多的工具（TodoWrite 那种）照样能拼出好几屏。
*/
const SUMMARY_KEYS = 3;
const SUMMARY_VALUE_CHARS = 60;
const SUMMARY_TOTAL_CHARS = 140;

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 参数值压成一行。
 *
 * 换行要塌成空格，不是为了好看：摘要行是 `truncate` 的单行，浏览器本来就会把换行渲染成
 * 空格——不塌的话字符预算全花在看不见的空白上，截断出来的一行比实际显示的短一大截。
 */
function shortValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value)
      : safeStringify(value);
  return text.replace(/\s+/g, " ").trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // 循环引用之类。JSON.parse 出来的东西不会有，但这函数不该假设调用方只喂它解析结果。
    return String(value);
  }
}

/**
 * 摘要行里那一行字：拿得到就是有信息量的一行，拿不到返回 null 让调用方自己兜底。
 *
 * **主语优先。** `toolSubject` 取的是命令 / 路径 / 模式 / URL，那是一次调用里最可读的东西，
 * 有它就不该退而求其次。k=v 是主语取不到时才用的——参数是结构化 JSON、但里面没有一个我们
 * 认识的字段（TodoWrite、各种 MCP 工具都是这样），这时候直接显示参数原文就是一坨花括号。
 *
 * 下划线开头的键跳过：那是各家 CLI 塞的内部字段（`_meta` 之类），占位置且对用户没意义。
 */
export function toolSummary(args: ToolArgs): string | null {
  // 主语可能是纯空白（预览态的 raw 原样顶上来的），那和没有主语是一回事。
  const subject = toolSubject(args);
  if (subject?.trim()) return subject;
  const json = args.json;
  if (!json) return null;
  const keys = Object.keys(json).filter(key => !key.startsWith("_")).slice(0, SUMMARY_KEYS);
  if (!keys.length) return null;
  const parts = keys.map(key => `${key}=${clip(shortValue(json[key]), SUMMARY_VALUE_CHARS)}`);
  return clip(parts.join(" "), SUMMARY_TOTAL_CHARS);
}
