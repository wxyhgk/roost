/**
 * 工具参数的预览态截断。
 *
 * 在此之前预览态把整个参数对象压成一个标量——只留 `command ?? file_path ?? path`——
 * 于是 Grep 的 pattern、TodoWrite 的 todos、Read 的 offset/limit 在写库那一刻就没了。
 * 详情接口虽然存着完整 JSON，但那是另一次 IO，列表和会话流不会为了显示一行参数去拿。
 *
 * 改成按结构截断：保住对象的形状，只砍超出上限的那部分，而且**砍掉多少要自己报数**，
 * 免得读的人把截断后的值当成原值。思路取自 happier-dev/happier（MIT）的 truncateDeep，
 * 位置是 apps/cli/src/agent/tools/redaction/redact.ts；这里是我们自己的实现。
 */

export type TruncateLimits = Readonly<{ maxString: number; maxArray: number; maxObjectKeys: number; maxDepth: number }>;

/**
 * 上限比 happier 紧一大截（他们是 2000 / 50 / 200 / 6），因为两边要塞进的地方不一样：
 * 他们截的是落盘日志，我们截的是消息预览——要和同一条消息里的正文抢同一份总预算
 * （claude.ts 的 PREVIEW = 4000 是整条消息的额度，不是单个参数的）。
 *
 * - maxString 300：一条 shell 命令、一个 glob、一个正则、一条绝对路径都在这个量级以内，
 *   截到 300 仍然看得出是哪一次调用。Edit 的 old_string/new_string 那种整段代码本来就
 *   不该在预览里读，要读去详情。
 * - maxArray 20：预览里会出现的数组是 TodoWrite 的 todos、多文件工具的路径列表这一类，
 *   十来项是常态；20 项足够看出形状，再多也只是同一种东西重复。
 * - maxObjectKeys 40：单个工具的参数 schema 最宽的也就十几个键（Grep 约 12 个），
 *   40 留足余量；真超过 40 说明这不是一份参数，而是被当成参数塞进来的数据。
 * - maxDepth 4：参数里最深的形状是「参数对象 → 数组 → 数组项对象 → 标量」，三层到底。
 *   给到 4 层，再深的东西不值得为它花掉预览的额度。
 */
export const PREVIEW_ARG_LIMITS: TruncateLimits =
  Object.freeze({ maxString: 300, maxArray: 20, maxObjectKeys: 40, maxDepth: 4 });

/** 截断标记走中文，和 `[未支持的记录内容]` 这些既有的占位符保持一致。 */
const DEPTH_MARK = "[超出深度]";
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function walk(value: unknown, limits: TruncateLimits, depth: number, state: { truncated: boolean }): unknown {
  if (depth > limits.maxDepth) { state.truncated = true; return DEPTH_MARK; }
  if (typeof value === "string") {
    if (value.length <= limits.maxString) return value;
    state.truncated = true;
    return value.slice(0, limits.maxString) + `…[截断 ${value.length - limits.maxString} 字符]`;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.maxArray).map(item => walk(item, limits, depth + 1, state));
    if (value.length <= limits.maxArray) return kept;
    state.truncated = true;
    return [...kept, `…[截断 ${value.length - limits.maxArray} 项]`];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) out[key] = walk(item, limits, depth + 1, state);
  // 键被砍掉时记数而不是记键名：键名本身可能很长，而这里要省的就是长度。
  if (entries.length > limits.maxObjectKeys) { state.truncated = true; out._truncatedKeys = entries.length - limits.maxObjectKeys; }
  return out;
}

/** 深度截断一份任意值，返回截断后的值和「有没有真的截到东西」。 */
export function truncateDeep(value: unknown, limits: TruncateLimits = PREVIEW_ARG_LIMITS): { value: unknown; truncated: boolean } {
  const state = { truncated: false };
  return { value: walk(value, limits, 0, state), truncated: state.truncated };
}

/**
 * 七个解析器的预览态共用这一个出口：拿到可以直接拼进 `name + ": "` 后面的字符串。
 * `undefined` 当成空参数，非对象参数照 JSON 原样序列化——预览不该因为参数形状奇怪就崩。
 */
export function previewToolArgs(value: unknown, limits: TruncateLimits = PREVIEW_ARG_LIMITS): { text: string; truncated: boolean } {
  const { value: bounded, truncated } = truncateDeep(value === undefined ? {} : value, limits);
  // JSON.stringify 对函数/symbol 返回 undefined，落到这里只会是坏数据，给个空对象别让调用方拿到 undefined。
  const text: string | undefined = JSON.stringify(bounded);
  return { text: text === undefined ? "{}" : text, truncated };
}

/**
 * 参数本身就是一段自由文本时（codex 的 custom_tool_call input）走这一个：照同一个字符串上限截，
 * 但不套 JSON 引号——那种记录里它本来就是原样文本，加引号只会让前端更难认。
 */
export function previewToolText(value: string, limits: TruncateLimits = PREVIEW_ARG_LIMITS): { text: string; truncated: boolean } {
  const { value: bounded, truncated } = truncateDeep(value, limits);
  return { text: typeof bounded === "string" ? bounded : value, truncated };
}
