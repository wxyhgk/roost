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
  | { kind: "tool"; id: string; name: string; args: string; result: string | null; failed: boolean; patch?: EditPatch };

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
      if (part.type === "tool_result" || part.type === "tool_error") {
        const target = part.toolCallId ? pending.get(part.toolCallId) : undefined;
        if (target) {
          target.result = text(part);
          target.failed = part.type === "tool_error";
          if (part.patch?.hunks.length) target.patch = part.patch;
          pending.delete(part.toolCallId!);
          continue;
        }
        /*
          配不上对的结果仍然要显示——历史被截断、或者调用发生在拉取范围之外时会这样。
          **默默丢掉比显示一个孤儿更糟**：用户会以为那一步没发生。
        */
        blocks.push({ kind: "tool", id: part.toolCallId ?? "", name: "", args: "",
          result: text(part), failed: part.type === "tool_error",
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
  | { kind: "diff"; key: string; diff: TurnDiff; turnStart: false };

export type ToolsStatus = "running" | "error" | "completed";

/**
 * 一组的状态：**只要有一个还没回来就是 running**，否则有失败就是 error。
 *
 * 「还没结束」压过「其中有失败」——对一个摘要来说，先要回答的是「这一步做完了没有」。
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
        pendingTools ??= { tools: [], message: row.message, key: `${row.message.messageId}:tools`, role: row.role };
        pendingTools.tools.push(block);
        turnTools.push(block);
        continue;
      }
      flush();
      if (isUser && index === 0) { closeTurn(); turnKey = row.message.messageId; }
      items.push({ kind: "text", key: `${row.message.messageId}:${index}`, role: row.role,
        text: block.text, message: row.message, turnStart: isUser && index === 0 });
    }
  }
  flush();
  closeTurn();
  return items;
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
