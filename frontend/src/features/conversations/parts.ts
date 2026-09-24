import type { EditPatch, HistoryMessage, MessagePart } from "../../shared/api/conversationPayloads";

/**
 * 把一串消息整理成能渲染的行。
 *
 * **工具调用和它的结果不在同一条消息里。** Claude 的 transcript 把 `tool_result` 放进
 * 紧接着的那条 user 消息，于是原样渲染会得到两个后果：工具输出和调用离散在两处，
 * 而且用户会看到自己"说"了一堆从没说过的话——那条 user 消息其实只装着工具结果。
 *
 * 所以配对必须跨消息做，并且**只剩工具结果的那条消息不显示**。写成纯函数是因为这些
 * 规则每一条都测得到，混在组件里就测不到。
 */

export type Block =
  | { kind: "text"; text: string }
  /**
   * `/compact` 留下的上下文摘要。
   *
   * 它在 transcript 里是一条 `role: "user"` 的记录（解析器按记录级的 `isCompactSummary`
   * 认出来），但**不是用户说的话**——实测每条一万四千字起。当普通文本画会得到一条巨型
   * 用户气泡，还会凭空多一条回合边界。画成分隔行，内容折起来但留着：摘要是这段历史唯一
   * 剩下的东西，藏掉比画错更糟。
   */
  | { kind: "compaction"; text: string }
  /**
   * 注入进模型的上下文——「这次对话模型实际看到了什么」。
   *
   * 各家 CLI 的形状不同：Claude 写成独立的 attachment 行，qwen 把它**拼进用户消息自己的
   * text 部件里**（`systemPayload.displayText` 才是用户真正打的那一段）。共同点是
   * **它不是用户说的话**——当普通文本画就会让用户看到自己「说」了一堆从没说过的话。
   *
   * `label` 是供应商自己的类型名（`environment` / `skill_listing` / …）。那是这条注入唯一
   * 自带的、准确的身份，比我们另编一套分类靠谱；取不到就空着，行上只写「上下文」。
   */
  | { kind: "context"; label: string; text: string }
  | { kind: "tool"; id: string; name: string; args: string; result: string | null; failed: boolean;
      /**
       * 这次调用被拦下来了，**命令根本没执行**——用户拒绝、auto 模式拦截、权限规则都算。
       *
       * 和 `failed` 分开是因为它们是两件事：失败是跑了之后的结果，拒绝是压根没跑。合成一个
       * 布尔的话，一次「我不让它删这个目录」会在对话里显示成一次错误——报告一个没发生过的
       * 故障。判据来自解析器（`packages/ai-transcript/src/claude.ts` 读记录级的
       * `toolDenialKind`），不是这里猜文本。
       */
      denied?: boolean; patch?: EditPatch };

export type Row = { message: HistoryMessage; role: string; blocks: Block[] };

const text = (part: MessagePart) => (part.text ?? "").trim();

/** 工具名：解析器把参数拼成了 `Bash: npm test`，名字单独也在 `name` 上。 */
function toolArgs(part: MessagePart) {
  const raw = part.text ?? "";
  const name = part.name ?? "";
  return name && raw.startsWith(name + ": ") ? raw.slice(name.length + 2) : raw;
}

export function groupMessages(messages: readonly HistoryMessage[]): Row[] {
  const rows: Row[] = [];
  /* 调用先出现、结果在后面的消息里，所以要留一张按 toolCallId 找回去的表。 */
  const pending = new Map<string, Extract<Block, { kind: "tool" }>>();
  for (const message of messages) {
    const role = message.event.role ?? "assistant";
    const parts = message.event.data?.parts;
    const blocks: Block[] = [];
    if (!parts?.length) {
      // 没有 parts 的老数据：按 content 渲染，一个字都不丢。
      const content = (message.event.content ?? "").trim();
      if (content) blocks.push({ kind: "text", text: content });
      rows.push({ message, role, blocks });
      continue;
    }
    for (const part of parts) {
      if (part.type === "tool_call") {
        const block: Extract<Block, { kind: "tool" }> = {
          kind: "tool", id: part.toolCallId ?? "", name: part.name ?? "", args: toolArgs(part),
          result: null, failed: false,
        };
        blocks.push(block);
        if (block.id) pending.set(block.id, block);
        continue;
      }
      if (part.type === "context") {
        const value = text(part);
        const label = typeof part.contextLabel === "string" ? part.contextLabel : "";
        if (value) blocks.push({ kind: "context", label, text: value });
        continue;
      }
      if (part.type === "compaction") {
        const value = text(part);
        if (value) blocks.push({ kind: "compaction", text: value });
        continue;
      }
      if (part.type === "tool_result" || part.type === "tool_error" || part.type === "tool_denied") {
        const target = part.toolCallId ? pending.get(part.toolCallId) : undefined;
        if (target) {
          target.result = text(part);
          target.failed = part.type === "tool_error";
          target.denied = part.type === "tool_denied";
          if (part.patch?.hunks.length) target.patch = part.patch;
          pending.delete(part.toolCallId!);
          continue;
        }
        /*
          配不上对的结果仍然要显示——历史被截断、或者调用发生在拉取范围之外时会这样。
          **默默丢掉比显示一个孤儿更糟**：用户会以为那一步没发生。
        */
        blocks.push({ kind: "tool", id: part.toolCallId ?? "", name: "", args: "",
          result: text(part), failed: part.type === "tool_error", denied: part.type === "tool_denied",
          ...(part.patch?.hunks.length ? { patch: part.patch } : {}) });
        continue;
      }
      const value = text(part);
      if (!value) continue;
      const last = blocks.at(-1);
      if (last?.kind === "text") last.text += "\n\n" + value;   // 连续文本段合成一段
      else blocks.push({ kind: "text", text: value });
    }
    // 只装工具结果的那条消息（Claude 的合成 user 回合）不该出现在对话里。
    if (blocks.length) rows.push({ message, role, blocks });
  }
  return rows;
}

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/**
 * 一屏里能被眼睛当成一个东西的单位。
 *
 * 一次 AI 回合里工具调用可以有十几次，一条一条平铺就是一片噪音。所以**连续的工具调用
 * 收成一组**，摘要显示「N 次调用 + 状态」，展开才看细节。
 */
export type Item =
  | { kind: "text"; key: string; role: string; text: string; message: HistoryMessage; turnStart: boolean }
  | { kind: "tools"; key: string; role: string; tools: ToolBlock[]; status: ToolsStatus; message: HistoryMessage; turnStart: boolean }
  /** 一个回合改了什么的汇总，摆在这个回合的末尾。 */
  | { kind: "compaction"; key: string; text: string; turnStart: false }
  | { kind: "context"; key: string; label: string; text: string; turnStart: false }
  | { kind: "diff"; key: string; diff: TurnDiff; turnStart: false };

export type ToolsStatus = "running" | "error" | "completed";

/**
 * 一组的状态：**只要有一个还没回来就是 running**，否则有失败就是 error。
 *
 * 「还没结束」压过「其中有失败」——对一个摘要来说，先要回答的是「这一步做完了没有」。
 *
 * 被拒绝的调用（`denied`）不算 error：它没跑，也就没失败。这里**不为它加第四种状态**——
 * 组头只有三种颜色，加一种要牵动 ConversationDetail 的样式和文案，而「用户自己刚拒绝的东西」
 * 用户本来就知道。真正要修的是「显示成失败」，那一条在 SummaryRow 的行内标签上已经修掉了。
 */
export function toolsStatus(tools: readonly ToolBlock[]): ToolsStatus {
  if (tools.some(tool => tool.result === null)) return "running";
  return tools.some(tool => tool.failed) ? "error" : "completed";
}

/**
 * 一组少于这个数就不收起来。
 *
 * 把一两次调用收进一个要点开的组，等于用一次点击换零信息。参考 happier 的做法：短的
 * 直接展开免得界面看着空，长的保持折叠免得「用一整块高高的内容霸占对话底部」。
 */
export const MIN_GROUPED_TOOLS = 3;

/**
 * 工具条目一律算 AI 的动作，**不看承载它的那条消息是什么角色**。
 *
 * 这不是化简，是纠错。工具结果在 Claude 的 transcript 里装在合成的 user 回合里；平时
 * `groupMessages` 会把结果并回调用那一条、把空壳消息丢掉，角色自然是 assistant。但配不上
 * 对的结果（历史分页时调用落在窗口之外、或被截断）会留下一个孤儿块，那条 user 消息因此
 * 活了下来——照着 `row.role` 走，一整组工具调用就被标成「你」、还靠右对齐成用户气泡的样子。
 *
 * 用户没有调用过任何工具。角色在这里是**传输的外壳**，不是说话的人。
 */
const TOOL_ROLE = "assistant";

/**
 * 把行拍平成条目，并把**连续的**工具调用收成组。
 *
 * 连续是跨消息的：一次回合里 AI 往往是「调用 → （下一条消息里的结果）→ 再调用」，
 * 中间那条只装结果的消息已经在 groupMessages 里被去掉了。
 *
 * `turnStart` 标在每条用户发言上——一个回合从用户说话开始。视觉上给回合一条边界，
 * 否则「提问 → 十几次工具 → 回答」在长对话里会糊成一片。
 */
export function buildItems(rows: readonly Row[]): Item[] {
  const items: Item[] = [];
  /*
    回合的改动汇总要等这个回合结束才知道，所以攒着，到下一个回合开始（或全部结束）时
    才落下去。「这一轮总共动了什么」是用户最想先看到的一句，而它按定义只能事后算出来。
  */
  let turnTools: ToolBlock[] = [];
  let turnKey = "";
  const closeTurn = () => {
    const diff = turnDiff(turnTools);
    turnTools = [];
    if (diff) items.push({ kind: "diff", key: `${turnKey}:diff`, diff, turnStart: false });
  };
  let pendingTools: { tools: ToolBlock[]; message: HistoryMessage; key: string; role: string } | null = null;
  const flush = () => {
    if (!pendingTools) return;
    const { tools, message, key, role } = pendingTools;
    pendingTools = null;
    if (tools.length >= MIN_GROUPED_TOOLS) {
      items.push({ kind: "tools", key, role, tools, status: toolsStatus(tools), message, turnStart: false });
      return;
    }
    // 太少就不成组：一条条摊开，各自是一个单元素的组，渲染上不带组的外壳。
    tools.forEach((tool, i) => items.push({ kind: "tools", key: `${key}:${i}`, role, tools: [tool],
      status: toolsStatus([tool]), message, turnStart: false }));
  };
  for (const row of rows) {
    const isUser = row.role === "user";
    for (const [index, block] of row.blocks.entries()) {
      if (block.kind === "tool") {
        turnTools.push(block);
        /*
          **带 diff 的调用不进组。** `PatchTool` 顶上那句——「不折叠，它到底改了什么是用户
          最关心的结果」——被组一收就作废了：折叠之后它和别的调用一样只剩一行字，而真正
          要看的绿红行藏在两次点击之后。

          所以它打断连续：前面攒着的先落下去，自己独占一条。代价是一个回合里改了好几个
          文件时组会被切成几段，那正是想要的——每段的边界就是一次改动。
        */
        if (block.patch?.hunks.length) {
          flush();
          items.push({ kind: "tools", key: `${row.message.messageId}:patch:${index}`, role: TOOL_ROLE,
            tools: [block], status: toolsStatus([block]), message: row.message, turnStart: false });
          continue;
        }
        pendingTools ??= { tools: [], message: row.message, key: `${row.message.messageId}:tools`, role: TOOL_ROLE };
        pendingTools.tools.push(block);
        continue;
      }
      flush();
      /*
        压缩摘要**不开新回合**。它在 transcript 里是 user 角色，照常走下面那条就会画出一条
        回合边界——可上下文压缩发生在一个回合中间，不是用户说了新的话。
      */
      if (block.kind === "context") {
        /*
          **注入不开新回合。** 它夹在一次工具循环中间是常态（Bash 里 `cd` 一下就有一条
          环境注入），当成用户发言会凭空多出一条回合边界，而那条边界不对应任何一件事。
        */
        items.push({ kind: "context", key: `${row.message.messageId}:${index}`,
          label: block.label, text: block.text, turnStart: false });
        continue;
      }
      if (block.kind === "compaction") {
        items.push({ kind: "compaction", key: `${row.message.messageId}:${index}`, text: block.text, turnStart: false });
        continue;
      }
      if (isUser && index === 0) { closeTurn(); turnKey = row.message.messageId; }
      items.push({ kind: "text", key: `${row.message.messageId}:${index}`, role: row.role,
        text: block.text, message: row.message, turnStart: isUser && index === 0 });
    }
  }
  flush();
  closeTurn();
  return items;
}

/**
 * 每条条目上面要不要标「你 / AI」，一次算出整串。
 *
 * 同一个角色连着说好几条时只标第一条——一次回合里 AI 往往是「调用 → 改动 → 再调用」，
 * 每条都顶一个「AI」纯属噪音，还把真正的分界（换人说话）淹掉。
 *
 * **diff、压缩摘要、注入这三种都不算换人**：它们没有角色、夹在同一个回合中间，所以既
 * 自己不标，也要跨过去记住上一个真实角色——否则它们后面那条会莫名其妙又标一次。
 *
 * `turnStart` 压过「和上一条同一个人」：一个回合的第一句必须标上，即使上一个回合也是
 * 用户说的最后一句（比如中间只有一条注入）。
 *
 * 写成纯函数、不留在组件的 useMemo 里，理由和 `outlineOf` 一样：三条规则都测得到，
 * 而搬出来之前它一行测试都没有——`tests/ui/conversation-render.test.tsx` 把 showRole 写死成 true。
 */
export function roleFlags(items: readonly Item[]): boolean[] {
  let last: string | undefined;
  return items.map(item => {
    if (item.kind === "diff" || item.kind === "compaction" || item.kind === "context") return false;
    const show = item.turnStart || item.role !== last;
    last = item.role;
    return show;
  });
}

/** 一个回合里所有改动的汇总：改了哪些文件、各自加删多少。 */
export type TurnDiff = {
  files: { path: string; added: number; removed: number; truncated: boolean }[];
  added: number;
  removed: number;
  truncated: boolean;
};

/**
 * 把一个回合里的改动按文件合起来。
 *
 * 规则取自 orca 的 `native-chat-turn-diffs`（research/third-party/orca，MIT），逻辑重写：
 *
 * - **同一回合里对同一个文件的多次编辑要合并。** 一个回合常常反复改同一个文件，
 *   列出三条「Edit 某文件」是噪音，一行 `+12 −4` 才是答案。
 * - **`truncated` 是黏性的。** 任何一段被截断，总数就只是个下界——必须说出来，
 *   不能把截断过的数字当成准确的报给用户。
 *
 * 它还合并重命名（oldPath → path）。**我们不实现那条**：Claude 的 structuredPatch 里
 * 没有 oldPath，猜不出来就不猜。
 */
function countLines(hunks: EditPatch["hunks"]) {
  let added = 0, removed = 0;
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export function turnDiff(tools: readonly ToolBlock[]): TurnDiff | null {
  const byPath = new Map<string, TurnDiff["files"][number]>();
  for (const tool of tools) {
    const patch = tool.patch;
    if (!patch?.hunks.length) continue;
    const path = patch.filePath ?? "";
    const { added, removed } = countLines(patch.hunks);
    const previous = byPath.get(path);
    byPath.set(path, {
      path,
      added: added + (previous?.added ?? 0),
      removed: removed + (previous?.removed ?? 0),
      truncated: patch.truncated || (previous?.truncated ?? false),
    });
  }
  if (!byPath.size) return null;
  const files = [...byPath.values()];
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    truncated: files.some(f => f.truncated),
  };
}
