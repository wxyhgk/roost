/**
 * 「这一次对话，模型实际看到了什么」——Claude Code 的 `attachment` 行。
 *
 * 每一条记的都是**被注入进模型上下文的一段内容**：系统提示词快照、环境信息、在外面被改过
 * 的文件、技能/agent 清单、hook 说的话。解析器此前把它们整条丢掉（`row.type` 不是
 * user/assistant 就 `partial: true`），代价有两层：
 *
 * - **本机 90 份 transcript，90 份都有 attachment 行**，合计 7609 条全部被计进 `skipped`，
 *   于是上层看到的「漏读条数」里有一大半根本不是漏读。（认了它们之后 `status` 仍然会是
 *   `partial`：`atis-latch` / `bridge-session` / `mode` / `permission-mode` 这些记账行还有
 *   四千多条，那是另一批记录、另一个决定，不在这次的范围里。）
 * - 「这场对话模型到底看到了什么系统提示词 / 什么环境」在界面上根本不存在，而那是
 *   AI coding 对话里唯一能解释「它为什么这么答」的东西。
 *
 * 和 `EditPatch` / `MessageUsage` 是同一个道理：数据在源头就有，我们只是没去取。
 */

import { truncateDeep } from "./truncate.ts";

export type ContextTier = "inline" | "collapsed";

/**
 * 一次上下文注入的元数据。正文在 part 的 `text` 上，这里只放「它是什么、该怎么摆」。
 *
 * `length` 是**截断之前**的真实字符数，所以它和 part 里实际拿到的 `text.length` 一比就知道
 * 被砍了多少——这和 `EditPatch.truncated`、`MessageUsage` 里「不完整的统计不许伪装成完整的」
 * 是同一条规矩。
 */
export type ContextInjection = {
  /** 供应商的类型名原样带出，如 `environment` / `prompt_snapshot`。不做白名单，见下。 */
  kind: string;
  tier: ContextTier;
  /** 能指认对象时给出的主语：文件路径、hook 名。指认不到就缺席，不编。 */
  subject?: string;
  /** 注入正文截断前的字符数。 */
  length: number;
  /**
   * 这条注入能不能按结构去画。**喂不满就整个缺席**——半份数据比没有更糟：渲染那一层拿到
   * 一个空壳表格，读的人以为「这次真的什么都没有」，而真相是我们没凑齐。缺席时正文
   * （part 的 `text`）仍然是完整的，退回按原文画就行。
   */
  source?: ContextSource;
};

/**
 * 结构化视图的入参，按 form 分档。
 *
 * **这是一张按 `kind` 写死的表（{@link FORMS}），不是按形状嗅探的。** 嗅探会在新类型上
 * 误命中——一个恰好有 `entries` 数组的新 attachment 会被画成技能清单，而那比画成原文更糟：
 * 它看着像对的。表里没有的类型一律不给 `source`，退回原文，这和「不认识的类型默认折叠」
 * 是同一条保守。
 *
 * **有上限。** `source` 不走正文那份额度，所以它自己得封顶（{@link SOURCE_BUDGET}）：
 * 一条 `skill_listing` 的清单本身就有 8.8KB，不封顶就等于把每条注入的载荷翻一倍。
 * 砍到了就标 `truncated`——和 `EditPatch` 一样，截断过的东西不许伪装成完整的。
 */
export type ContextSource =
  /**
   * 注入了哪些指令文件（CLAUDE.md / AGENTS.md / AutoMem）。
   *
   * **`action` 一律 `set`、`baseline` 一律 true。** 转录里没有 action 字段，而实测 64 条
   * `instructions` 全都是「把一份文件整个摆进来」：唯一的附加信息是 `reason`，只有
   * `session_start` 和 `compaction` 两种（各 1 条），都是「重新铺一次底」，没有一条表达
   * 删除或增量。猜一个 `replace` 出来只会让界面报告一件没发生过的事。
   * `digest` 数据里没有，就不给。
   */
  | { form: "instructions"; changes: { action: "set" | "replace" | "remove"; path: string; digest?: string }[]; baseline?: boolean }
  /**
   * 一份清单：技能、agent、延迟加载的工具。
   *
   * 三种来源的形状不一样，拼成同一副骨架：`deferred_tools_record` 自带 `entries[]`；
   * `skill_listing.content` / `agent_listing_delta.addedLines` 是 `"- 名字: 说明"` 的行；
   * `deferred_tools_delta.addedLines` 只有名字——**`description` 为空串是合法的**，
   * 「这次加了这些工具」本身就是全部信息。
   *
   * `update` 只在数据里有 `isInitial` 时给（`skill_listing` / `agent_listing_delta` 都有）。
   * 没有的那两种由前端按出现顺序补，理由见 `parts.ts`。
   */
  | { form: "catalog"; entries: { name: string; description: string }[]; update?: boolean; truncated?: boolean }
  /**
   * 一份快照的逐项展开：对象的每个键一段。
   *
   * 只给 `environment` 和 `session_context` 这两种**整份重发**的：上游这一档带着一句
   * 「取代先前的快照」的固定文案，那句话对它们成立（`environment` 实测会在一场会话里
   * 重发上百次，每次都是完整的一份）。增量型的类型不许进这一档。
   */
  | { form: "snapshot"; sections: { name: string; text: string }[]; truncated?: boolean }
  /**
   * 一行话摘要，骑在折叠行上：不展开就能读。
   *
   * **摘要一律从数据里取，不在这里拼散文。** 这个包没有 i18n（现成的
   * `[未支持的记录内容]` 已经是一句永远翻不了的硬编码中文），再往里塞几句只会多几个包袱；
   * 而这三种类型的数据本身就是那一行话——日期就是日期、会话链接就是链接、排队的那条
   * 消息就是用户说的话。行头已经用 `kind` 当生产者名，摘要不必再重复一遍「这是日期」。
   */
  | { form: "notice"; summary: string }
  /**
   * 系统提示词快照，走独立的 `SystemPromptRow`。
   *
   * **正文不在这里重复一份**：`prompt_snapshot` 本机最大 142KB，把它再抄进 `source` 等于
   * 把这条记录的体积翻一倍，而且会多出一个要各自截断、各自对齐的副本。正文就是 part 的
   * `text`，渲染时直接用那一个。
   *
   * `update`（是不是同一份转录里的第 2+ 次）在这一层**算不出来**：读取器是按字节增量走的，
   * 而 `readClaudeDetail` 回读单行时连会话上下文都没有——同一条记录会在流式和回读两条路上
   * 得出不同的答案。它是序列的性质不是记录的性质，所以交给前端的 `buildItems` 去补。
   */
  | { form: "system_prompt"; update?: boolean };

/**
 * **不产出 part 的类型。**
 *
 * 只有 `total_tokens_reminder` 一种，但它一种就占了非 sidechain attachment 行的
 * **3117 / 3894 ≈ 80%**（本机 90 份 transcript；另有 3715 条在 sidechain 里，解析器在第一行
 * 就丢了，不计入）。它的正文是一句 49 字符的话，唯一在变的是一个递减的计数器：
 *
 *     <total_tokens>15000000 tokens left</total_tokens>
 *     <total_tokens>14960813 tokens left</total_tokens>
 *
 * 一份 transcript 里中位 20 条，最多的一份 1485 条。全都产出来就是在对话里刷几千行
 * ——而且刷的是一个和对话内容无关的数：「还剩多少额度」上层已经有 `MessageUsage` 这个
 * 更准也更好折算的来源。
 *
 * **丢它算「明知故丢」，不算解析失败**（`partial: false`）。丢弃和漏读是两件事：记成漏读的话，
 * 光这一种就能给一份转录记上一千多条「没读到」，而 `skipped` 正是上层用来判断
 * 「这份历史缺不缺」的那个数。
 */
const DROP = new Set(["total_tokens_reminder"]);

/**
 * **默认展开的类型。**
 *
 * 判据是「载荷是不是**这次对话里被摆到模型眼前的具体内容**」——别处看不到、只此一份：
 *
 * | 类型 | 本机条数 | 正文互不相同的比例 |
 * | --- | --- | --- |
 * | `file`（用户 @ 进来的文件） | 16 | 100% |
 * | `edited_text_file`（模型读过的文件在外面被改了，重新注入的新内容） | 65 | 88% |
 * | `hook_system_message`（hook 往对话里说的话） | 2 | 100% |
 *
 * 其余一律折叠，理由见 {@link contextTier}。**`queued_command` 特意不在这里**：34 条里有 5 条
 * 的正文后来又原样作为一条用户消息出现过，展开会把同一句话在对话里显示两遍。
 */
const INLINE = new Set(["file", "edited_text_file", "hook_system_message"]);

/**
 * 分档。`undefined` 表示这一类不产出 part。
 *
 * **不认识的类型默认折叠**，而不是丢掉、也不是展开。Claude Code 每个版本都在加新的
 * attachment 类型（本机已经见到 23 种），白名单式的处理意味着新类型一出现就静默消失；
 * 折叠这一档是「看得见、不吵、也不会丢」，对一个还没人读过的新类型来说这是唯一安全的默认值。
 */
export function contextTier(kind: string): ContextTier | undefined {
  if (DROP.has(kind)) return undefined;
  return INLINE.has(kind) ? "inline" : "collapsed";
}

/**
 * 能指认「这条注入是关于谁的」的字段，按这个顺序取第一个字符串。
 *
 * 按字段名而不是按类型写死：`filename` 在 `file` / `edited_text_file` / `compact_file_reference`
 * 上都是同一个意思，将来新增的类型只要沿用同一批名字就自动认得。取不到就没有主语，
 * 不从正文里猜一个出来。
 */
const SUBJECT_KEYS = ["filename", "path", "displayPath", "hookName", "planFilePath"];
const SUBJECT_MAX = 1024;

export function contextSubject(payload: Record<string, unknown>): string | undefined {
  for (const key of SUBJECT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value) return value.slice(0, SUBJECT_MAX);
  }
  return undefined;
}

/**
 * 正文字段：`rendered` 缺席时按这个顺序在载荷里找一段文本。
 * 值是字符串就直接用，是字符串数组就拼起来（`prompt_snapshot.systemPrompt` 就是后者）。
 */
const TEXT_KEYS = ["content", "systemPrompt", "text"];
/**
 * 拼接用换行而不是空行：唯一会走数组分支的是 `prompt_snapshot.systemPrompt`，它的每一段
 * 本来就是同一份提示词的相邻片段（中间还有 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 这样的
 * 分界标记），中间塞空行会凭空改变它送进模型时的样子。
 */
const JOIN = "\n";

function joinText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value) && value.length && value.every(item => typeof item === "string"))
    return (value as string[]).join(JOIN) || undefined;
  return undefined;
}

/**
 * 注入的正文，**截断之前**的完整文本。
 *
 * **首选记录级的 `rendered`。** 那是 Claude Code 自己记下来的「这条注入最后变成了什么文本
 * 送进模型」，形状固定是 `[{ content: string }]`，本机 3661/3894 ≈ 94% 的行都有。用它就不必
 * 替 23 种 attachment 各写一套拼装——而且拼错了从界面上也看不出来，它是唯一的真相。
 *
 * 没有 `rendered` 的 5 种（`prompt_snapshot` / `deferred_tools_record` / `command_permissions` /
 * `thinking_stripped` / `hook_system_message`）退到载荷里找正文字段，见 {@link TEXT_KEYS}。
 *
 * 再找不到就把载荷按结构截断成 JSON。**看得懂比看不见强**：这一档只兜住 18 条记录，
 * 但它保证「新类型出现时界面上仍然有东西」，而不是一片空白。
 */
export function contextText(rendered: unknown, payload: Record<string, unknown>): string {
  if (Array.isArray(rendered)) {
    const text = rendered
      .map(block => block && typeof block === "object" && typeof (block as { content?: unknown }).content === "string"
        ? (block as { content: string }).content : "")
      .filter(Boolean).join(JOIN);
    if (text) return text;
  }
  for (const key of TEXT_KEYS) { const text = joinText(payload[key]); if (text) return text; }
  // 类型名已经单独在 `kind` 上，正文里再重复一遍只是浪费额度。
  const { type: _kind, ...rest } = payload;
  return JSON.stringify(truncateDeep(rest).value) ?? "";
}

/**
 * 哪种 attachment 走哪一档结构化视图。表里没有的一律不给 `source`，退回按原文画。
 *
 * **没有进表的三档**，因为数据喂不满，而喂半份比不喂更糟：
 * - `relay` 要发信方的 session id，最接近的 `queued_command` 只有后台任务 id——
 *   拿 task-id 顶上去会在界面上指认出一个不存在的会话。
 * - `recall` 要「保留几条、省略几条」的计数，而那个计数正是这张卡存在的理由；
 *   `compact_file_reference` 只有一个文件名，给不出数。
 * - `producer.role: "recall"`：Claude 的 attachment 全部是 `inject`，没有一条是回忆。
 */
const FORMS: Record<string, ContextSource["form"]> = {
  instructions: "instructions",
  skill_listing: "catalog", agent_listing_delta: "catalog",
  deferred_tools_delta: "catalog", deferred_tools_record: "catalog",
  environment: "snapshot", session_context: "snapshot",
  date: "notice", remote_session_change: "notice", queued_command: "notice",
  prompt_snapshot: "system_prompt",
};

/**
 * `source` 自己的字符预算。
 *
 * 取 4000，和正文预览同一档：结构化视图是给「不展开也能看懂」用的，完整原文在 part 的
 * `text` 里。不封顶的话，一条 `skill_listing`（清单本身 8.8KB）会让这条记录的载荷翻一倍，
 * 而列表一次要返回最多 200 条消息。条数另外封在 {@link SOURCE_ITEMS}。
 */
const SOURCE_BUDGET = 4000, SOURCE_ITEMS = 64, SOURCE_NAME = 200;
const SUMMARY_MAX = 200;
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : undefined;

/** 一份带预算的清单：名字必填，说明可以是空串，砍到了自己报数。 */
function boundedList<T extends { name: string }>(): { push(name: string, rest: Omit<T, "name">, cost: number): void; items: T[]; truncated: boolean } {
  const items: T[] = []; let budget = SOURCE_BUDGET, truncated = false;
  return { items, get truncated() { return truncated; },
    push(name, rest, cost) {
      if (!name) return;
      if (items.length >= SOURCE_ITEMS || budget < name.length) { truncated = true; return; }
      budget -= name.length + cost;
      items.push({ name, ...rest } as T);
    } };
}

/** `"- 名字: 说明"` 拆成两半。名字里不会有冒号（实测技能名、agent 名都没有），第一个冒号即分界。 */
const LISTING_LINE = /^\s*-\s+([^:\n]{1,200}?)\s*:\s*([\s\S]*)$/;

function catalogSource(payload: Record<string, unknown>): ContextSource | undefined {
  const list = boundedList<{ name: string; description: string }>();
  const add = (name: string, description: string) => {
    const desc = description.slice(0, Math.max(0, SOURCE_BUDGET - name.length));
    list.push(name.slice(0, SOURCE_NAME), { description: desc }, desc.length);
  };
  const raw = payload.entries;
  if (Array.isArray(raw)) {
    // `deferred_tools_record` 自带这个形状，零加工。
    for (const entry of raw) if (plain(entry) && typeof entry.name === "string")
      add(entry.name, typeof entry.description === "string" ? entry.description : "");
  } else {
    const lines = strings(payload.addedLines)
      ?? (typeof payload.content === "string" ? payload.content.split("\n") : undefined);
    if (!lines) return undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = LISTING_LINE.exec(line);
      // 拆不开的行（`deferred_tools_delta.addedLines` 就只有名字）整行当名字，说明留空。
      if (match) add(match[1], match[2].trim()); else add(line.trim().replace(/^-\s+/, ""), "");
    }
  }
  const update = typeof payload.isInitial === "boolean" ? !payload.isInitial : undefined;
  return { form: "catalog", entries: list.items,
    ...(update === undefined ? {} : { update }), ...(list.truncated ? { truncated: true } : {}) };
}

/** 快照对象里的值：字符串照抄，其余序列化——`String([])` 会把一个空数组变成空串，看不出它是数组。 */
const sectionText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? String(value);

function snapshotSource(payload: Record<string, unknown>): ContextSource | undefined {
  const object = plain(payload.snapshot) ? payload.snapshot : plain(payload.context) ? payload.context : undefined;
  if (!object) return undefined;
  const list = boundedList<{ name: string; text: string }>();
  for (const [name, value] of Object.entries(object)) {
    const text = sectionText(value).slice(0, SOURCE_BUDGET);
    list.push(name.slice(0, SOURCE_NAME), { text }, text.length);
  }
  // 至少要有一段，否则这一档画出来就是个空壳。
  if (!list.items.length) return undefined;
  return { form: "snapshot", sections: list.items, ...(list.truncated ? { truncated: true } : {}) };
}

function instructionsSource(payload: Record<string, unknown>): ContextSource | undefined {
  if (!Array.isArray(payload.files)) return undefined;
  const changes = payload.files.slice(0, SOURCE_ITEMS)
    .filter(file => plain(file) && typeof file.path === "string" && file.path)
    .map(file => ({ action: "set" as const, path: (file as { path: string }).path.slice(0, SOURCE_NAME) }));
  // 一条都没有就不给这一档：空的改动列表画出来是个空壳，比退回原文更糟。
  if (!changes.length) return undefined;
  return { form: "instructions", changes, baseline: true };
}

/**
 * 一行话摘要。
 *
 * `queued_command` 有两种形状：用户中途插的一句话（`prompt` 就是那句话），和后台任务的
 * 通知（`prompt` 是一段 XML，供应商自己在 `<summary>` 里写好了一行话）。先取 `<summary>`，
 * 取不到就取第一行非空文本——这两条覆盖了实测的全部 34 条。
 */
function noticeSource(payload: Record<string, unknown>): ContextSource | undefined {
  const raw = typeof payload.date === "string" ? payload.date
    : typeof payload.url === "string" ? payload.url
    : typeof payload.prompt === "string" ? payload.prompt : undefined;
  if (!raw) return undefined;
  const tagged = /<summary>([\s\S]*?)<\/summary>/.exec(raw);
  const line = (tagged ? tagged[1] : raw).split("\n").map(item => item.trim()).find(Boolean);
  if (!line) return undefined;
  return { form: "notice", summary: line.slice(0, SUMMARY_MAX) };
}

/** 见 {@link ContextSource}。喂不满就返回 `undefined`，让渲染退回按原文画。 */
export function contextSource(kind: string, payload: Record<string, unknown>): ContextSource | undefined {
  switch (FORMS[kind]) {
    case "instructions": return instructionsSource(payload);
    case "catalog": return catalogSource(payload);
    case "snapshot": return snapshotSource(payload);
    case "notice": return noticeSource(payload);
    // 正文就是提示词本身，这一档只带一个标记；`update` 由前端按出现顺序补。
    case "system_prompt": return typeof payload.systemPrompt === "string" || Array.isArray(payload.systemPrompt)
      ? { form: "system_prompt" } : undefined;
    default: return undefined;
  }
}
