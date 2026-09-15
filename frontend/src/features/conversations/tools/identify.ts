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
   * **大多数时候是 null，这不是 bug。** 解析器在写库时就把参数压成了预览态：Claude / qwen /
   * omp 只留 `command ?? file_path ?? path` 一个标量值（见
   * `packages/ai-transcript/src/claude.ts` 的 `textPreview`），完整 JSON 只有详情接口才给。
   * codex / gemini / opencode 存的是完整 JSON，所以它们能解出来。
   *
   * 也就是说渲染器**不能假设 json 存在**，拿不到就得靠 raw 顶着。
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
 * 预览态下 Claude 只留一个标量，那个标量**恰好就是**命令或路径（解析器按
 * `command ?? file_path ?? path` 的顺序挑的），所以 raw 本身就是主语。完整 JSON 的那几家
 * 才需要真的去取字段。
 */
export function toolSubject(args: ToolArgs): string | null {
  return argString(args, "command", "file_path", "filePath", "path", "pattern", "url")
    ?? (args.json ? null : args.raw || null);
}
