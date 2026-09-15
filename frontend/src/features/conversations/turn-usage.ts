import type { HistoryMessage } from "../../shared/api/conversationPayloads";
import type { TurnTokenUsage } from "../../vendor/dsh/chat/TurnUsagePanel";
import type { SessionTokenUsage } from "../../vendor/dsh/chat/StatsPills";
import type { Item } from "./parts";

/**
 * 把**消息级**的用量折成**回合级**的一份。
 *
 * 解析器（`packages/ai-transcript`）把 token 用量挂在每条 assistant 记录上，因为那是它的
 * 真实粒度：一次模型请求一份。而界面要回答的是「这一轮烧了多少」——中间隔着这一层。
 *
 * **写成纯 TS、不带 JSX**，和 `parts.ts`、`tools/dispatch.ts` 顶上是同一条理由：
 * `node --test` 加载不了 CSS Module，判定跟着 JSX 进去就一条都测不到了。这里连 `TurnTokenUsage`
 * 都是 `import type`——类型在编译期就被抹掉，不会把那个带 css 的组件拖进测试。
 */

/** 一个回合折出来的两样东西：用量和耗时。两样都可能不知道，不知道就是 null。 */
export type TurnStats = {
  /**
   * 回合首条消息的 messageId，也就是 `buildItems` 给 `kind: "diff"` 条目用的那个 turnKey。
   * 第一条用户发言之前的条目（历史被截断时会有）归到 key 为 `""` 的隐式回合。
   */
  turnKey: string;
  /** 这个回合里全部条目的 key，顺序同 items。 */
  itemKeys: string[];
  /** 这个回合里没有任何一次模型请求时是 null——**不是一堆 0**。 */
  usage: TurnTokenUsage | null;
  /** 回合首末消息 `createdAt` 之差。量不出来（少于两条消息带时刻）时是 null。 */
  runMs: number | null;
};

/** 带消息的条目才有用量和时刻；汇总行、思考行、压缩行是从别的条目派生出来的，没有自己的消息。 */
/**
 * 一个条目**贡献的全部消息**。
 *
 * **工具组要给整组跨过的那几条，不能只给第一条。** 一组连续的工具调用是跨消息的
 * （「调用 → 下一条消息里的结果 → 再调用」），而用量是按**每一条**消息计的。
 * 只取 `item.message` 的话，后面几条的用量整个丢掉——实测 fixture 里 5 条带 usage
 * 的记录被缩成 1 条，总量从 995,740 掉到 199,148，页面上显示成 199K。
 */
function messagesOf(item: Item): readonly HistoryMessage[] {
  if (item.kind === "tools") return item.messages;
  return item.kind === "text" ? [item.message] : [];
}

/**
 * 一个回合的用量。
 *
 * 三条纪律，一条都不能松：
 *
 * 1. **桶不全就整个不给那个桶。** 回合里只要有一条消息没上报缓存读/缓存写/思考，整个回合的
 *    那个桶就不出现，而不是当 0 补上。缺席和零是两件事：写成 0，界面会说「这次没思考」，
 *    而真相是没报。判据和 `MessageUsage`（`shared/api/conversationPayloads.ts`）、
 *    `TurnTokenUsage`（上游注释 `Present only when every attempt reported the bucket`）一致。
 * 2. **总数是四项相加**：未命中缓存的输入 + 缓存读 + 缓存写 + 输出。`reasoningTokens` 是
 *    `outputTokens` 的子集，**不另加**——加了等于把思考的那部分数两遍。
 * 3. 没有 TTFT、没有吞吐。见下面 `turnRunMs` 的说明。
 *
 * **总数只加上报过的数。** 某条记录缺了某个桶时，它在这条上没有数可加——于是当一个桶在回合里
 * 时有时无，总数是个下界。这不是「缺席当 0」的后门：那个桶的**分项照样整个消失**，用户不会
 * 拿一份看着完整的分项去对总数。反过来把已经拿到的那几条也丢掉，只会让总数更不准。
 * （本机实测：Claude 的输入/输出/缓存读写 100% 有，思考 99.7%，所以这条路在实践中几乎不走。）
 *
 * `routes` 要 provider 和 model 两样，而记录上只有 model——provider 是「这段对话用的哪个 CLI」，
 * 只有调用方知道。**不给就不猜**：没传 provider，或者这个回合里有任何一次请求没报 model，
 * 弹层里的「模型」那一行就不出现。
 */
function foldUsage(messages: readonly HistoryMessage[], provider: string | undefined): TurnTokenUsage | null {
  let attempts = 0;
  let uncachedInputTokens = 0, outputTokens = 0, totalTokens = 0;
  /* null = 这个桶在某条记录上缺席了，于是整个回合都不给。 */
  let cacheReadTokens: number | null = 0, cacheWriteTokens: number | null = 0, reasoningTokens: number | null = 0;
  const models: string[] = [];
  let everyAttemptHasModel = true;

  for (const message of messages) {
    const usage = message.event.data?.usage;
    /* 没有 usage 的记录不是一次模型请求：用户发言、只装工具结果的合成记录都没有。 */
    if (!usage) continue;
    attempts += 1;
    uncachedInputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    cacheReadTokens = usage.cacheReadTokens === undefined || cacheReadTokens === null
      ? null : cacheReadTokens + usage.cacheReadTokens;
    cacheWriteTokens = usage.cacheWriteTokens === undefined || cacheWriteTokens === null
      ? null : cacheWriteTokens + usage.cacheWriteTokens;
    reasoningTokens = usage.reasoningTokens === undefined || reasoningTokens === null
      ? null : reasoningTokens + usage.reasoningTokens;
    if (usage.model) { if (!models.includes(usage.model)) models.push(usage.model); }
    else everyAttemptHasModel = false;
  }

  /* 一次请求都没有：返回 null，而不是一份全零的用量——「没发生过」和「烧了 0 个 token」不一样。 */
  if (attempts === 0) return null;
  return {
    uncachedInputTokens, outputTokens, totalTokens,
    ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(provider && everyAttemptHasModel && models.length
      ? { routes: models.map(model => ({ provider, model })) } : {}),
  };
}

/**
 * 回合跑了多久：首末消息落盘时刻之差。
 *
 * **只给 `runMs`，不给 TTFT、不给 tokens/秒。** transcript 里没有首 token 时刻，拿两条消息的
 * `createdAt` 去减出一个「首 token 延迟」是撒谎——那是两次落盘的间隔，中间还夹着工具执行、
 * 用户发呆和写盘本身。调研笔记里那条（`research/deepseek-harness-chat-port.md` 第四节第 4 小节
 * 「不可行」）就是这件事。`TurnTimePanel` 的另外两行有 `!== undefined` 的闸门，不传就不画。
 *
 * 取的是有时刻的那些消息里的最早和最晚，而不是第一条和最后一条：时钟回拨、乱序写入都会让
 * 「末 − 首」变成负数，而一个负的耗时比没有耗时更糟。**少于两条带时刻就返回 null**——
 * 一个时刻量不出一段时间，补一个 0 会显示成「耗时 0 秒」，那是个编出来的数。
 */
function turnRunMs(messages: readonly HistoryMessage[]): number | null {
  let earliest: number | undefined, latest: number | undefined, stamped = 0;
  for (const message of messages) {
    const at = message.event.createdAt;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    stamped += 1;
    if (earliest === undefined || at < earliest) earliest = at;
    if (latest === undefined || at > latest) latest = at;
  }
  if (stamped < 2 || earliest === undefined || latest === undefined) return null;
  return latest - earliest;
}

/** 切好的一个回合：它的 key、它包住的条目、以及去重之后的消息。 */
type TurnSlice = { turnKey: string; itemKeys: string[]; messages: HistoryMessage[] };

/**
 * 按回合切条目。**回合级和会话级两条路共用这一份切分**——切两遍就会漂移，而漂移的那一天
 * 「本轮用量」和「会话统计」会各说各话。
 *
 * 回合边界已经在 `buildItems` 里算好了：`turnStart` 标在每个回合的第一条上（一个回合从用户
 * 说话开始）。这里**不重新判定边界**，同理。
 *
 * **同一条消息要按 messageId 去重。** 一条 assistant 消息在 `buildItems` 里会摊成好几个条目
 * （正文一条、工具一条、带 diff 的工具各自一条），按条目求和会把同一次请求的用量数好几遍。
 */
function splitTurns(items: readonly Item[]): TurnSlice[] {
  const turns: (TurnSlice & { seen: Set<string> })[] = [];
  for (const item of items) {
    const contributed = messagesOf(item);
    /*
      第一条用户发言之前也可能有条目（历史被截断、或者对话是从中间拉起来的）。它们照样属于
      「某个回合」，只是我们看不到那个回合的开头——归进一个 key 为空的隐式回合，而不是丢掉。
    */
    if (item.turnStart || turns.length === 0) {
      turns.push({ turnKey: item.turnStart && contributed[0] ? contributed[0].messageId : "",
        itemKeys: [], messages: [], seen: new Set() });
    }
    const turn = turns[turns.length - 1]!;
    turn.itemKeys.push(item.key);
    for (const message of contributed) {
      if (turn.seen.has(message.messageId)) continue;
      turn.seen.add(message.messageId);
      turn.messages.push(message);
    }
  }
  return turns;
}

/**
 * 按回合切条目，每个回合折一份统计。
 *
 * @param items - `buildItems` 的输出。
 * @param provider - 这段对话用的 CLI，做「模型」那一行的前缀。不传就不给 `routes`。
 * @returns 每个回合一份，顺序同 items。
 */
export function collectTurnStats(items: readonly Item[], provider?: string): TurnStats[] {
  return splitTurns(items).map(turn => ({
    turnKey: turn.turnKey,
    itemKeys: turn.itemKeys,
    usage: foldUsage(turn.messages, provider),
    runMs: turnRunMs(turn.messages),
  }));
}

/**
 * 同一份统计，按**条目 key** 查。
 *
 * 面板挂在哪一条上是渲染那边的事（回合汇总那条 `kind: "diff"` 是个好位置——那本来就是
 * 「这一轮做了什么」）。给一张覆盖全部条目的表，挂在哪条都是一次 `get`，这一层就不必知道
 * 答案，改挂别处也不用回头改。
 */
export function turnStatsByItemKey(items: readonly Item[], provider?: string): Map<string, TurnStats> {
  const byKey = new Map<string, TurnStats>();
  for (const turn of collectTurnStats(items, provider)) {
    for (const key of turn.itemKeys) byKey.set(key, turn);
  }
  return byKey;
}

/** 输入卡下面那两颗药丸（`vendor/dsh/chat/StatsPills`）要的**会话级**读数。 */
export type SessionStats = {
  /** 转录里画得出边界的回合数——读者自己能数的那个数。 */
  turns: number;
  /** 模型响应数，也就是上游说的「步」。 */
  steps: number;
  /** 四个桶有任何一个在任何一条记录上缺席时是 null——**不是一份补了 0 的账**。 */
  usage: SessionTokenUsage | null;
};

/**
 * 把**整段对话**折成一份会话级读数。
 *
 * **两个入参不是冗余，是两个不同的总体，这一点踩过一次：**
 *
 * - 回合边界只能从 `items` 读（`turnStart` 标在那上面），所以 `turns` 走 `splitTurns`；
 * - **用量和步数走原始记录。** 这里曾经有过一个少算：`buildItems` 把连续的工具调用收成
 *   一组，而那一组当时**只记住第一条消息**——跨消息的一串调用被收拢之后，后面那几条记录
 *   连同它们的 `usage` 在条目层面就不见了。[实测] 隔离 fixture 里 10 条记录（其中 5 条带
 *   usage）过一遍 `buildItems` 只剩 3 个条目、1 条带 usage，总量从 995,740 缩成 199,148。
 *
 *   **源头已经修了**：工具组现在带 `messages`（整组跨过的全部消息，去重），
 *   `splitTurns` 的 `messagesOf` 读的就是它，所以**回合级那两颗药丸也跟着对了**。
 *   这里仍然吃原始记录，是因为会话级要数的「步」是全部 assistant 记录，
 *   而条目层面根本不区分「一条消息摊成了几个条目」——两件事，两个总体。
 *
 * **「步」数的是 assistant 记录，不是带 `usage` 的记录。** 上游的 step 是 agent 循环里的
 * 一步，落到载荷上就是一次模型响应；改用「带 usage 的记录」会让不上报用量的 CLI 步数恒为 0，
 * 而那些步是真发生过的。用量报没报是另一颗药丸要回答的事。
 *
 * **四个桶缺一个就整份不给。** `SessionTokenUsage` 四项全是必填的，因为弹层里
 * 「未缓存输入 / 缓存读取 / 输出」三行是无条件画的——缺席当 0 会写出一句「缓存读取 0」，
 * 而真相是没报。这和 `foldUsage` 里逐桶剔除的那条是同一条规矩，只是这里桶不可选，
 * 于是「剔除一个桶」升级成「整份不给」。
 *
 * **不给任何计时。** transcript 里没有 step 开始时刻、没有首 token 时刻、工具调用和结果
 * 也没有配对时刻，所以模型用时 / 工具用时 / TTFT / 输出速度一项都算不出来。理由和
 * `turnRunMs` 上那段一样：两次落盘的间隔不是模型用时，中间夹着工具执行和用户发呆。
 * 调用方把 `WindowStats` 的六个计时字段传 0——那正是上游给它们写的语义（`0 when no node
 * carries timing`），`TimePill` 会因此退化成一个不可点的静态读数。
 *
 * @param items - `buildItems` 的输出，只用来数回合边界。
 * @param messages - 已加载的原始记录（`history.items`），用量和步数的真实总体。
 * @returns 一份会话级读数。既没有模型响应也没有 token 时，药丸那一行整个不画
 * （闸门在 `StatsPills` 里）。
 */
export function collectSessionStats(
  items: readonly Item[], messages: readonly HistoryMessage[],
): SessionStats {
  let steps = 0, billed = 0;
  let uncachedInputTokens = 0, outputTokens = 0;
  /* null = 这个桶在某一条记录上缺席了，于是整份账都不给。 */
  let cacheReadTokens: number | null = 0, cacheWriteTokens: number | null = 0;

  for (const message of messages) {
    if (message.event.role === "assistant") steps += 1;
    const usage = message.event.data?.usage;
    /* 没有 usage 的记录不是一次模型请求：用户发言、只装工具结果的合成记录都没有。 */
    if (!usage) continue;
    billed += 1;
    uncachedInputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens = usage.cacheReadTokens === undefined || cacheReadTokens === null
      ? null : cacheReadTokens + usage.cacheReadTokens;
    cacheWriteTokens = usage.cacheWriteTokens === undefined || cacheWriteTokens === null
      ? null : cacheWriteTokens + usage.cacheWriteTokens;
  }

  return {
    turns: items.length === 0 ? 0 : splitTurns(items).length,
    steps,
    usage: billed > 0 && cacheReadTokens !== null && cacheWriteTokens !== null
      ? { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } : null,
  };
}
