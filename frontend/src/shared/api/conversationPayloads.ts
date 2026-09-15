/**
 * 对话接口的线上载荷形状。
 *
 * **这些类型属于 api 层，不属于特性。** 它们描述的是服务端发回来什么，而不是前端拿它们
 * 做什么。原来它们和「历史合并规则」「投递状态语义」一起放在 features/conversations/ 下，
 * 于是 shared/api/conversations.ts 要伸进 features/conversations/ 去取类型才能标注自己的
 * 返回值——共享层反过来依赖特性，箭头是反的。
 *
 * 现在方向理顺了：api 定义载荷，特性拿载荷去做规则。规则（去重、取新、状态怎么解释）
 * 仍然留在特性里，那才是特性该管的东西。
 */

/** 一次文件改动的真实 hunk。供应商在写文件前就算好了，我们只是把它带过来。 */
export type EditPatch = {
  filePath?: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
  truncated: boolean;
};

/** 一条消息里的一段。`tool_call` 带工具名和参数，`tool_result` / `tool_error` 带输出。 */
export type MessagePart = {
  type?: string;
  text?: string;
  toolCallId?: string;
  name?: string;
  /** 只有改文件的工具结果才有。 */
  patch?: EditPatch;
  /**
   * 只有 `type: "context"` 的段才有：供应商自己的注入类型名（`environment` / `skill_listing`…）。
   *
   * **可选**：库里按旧形状写进去的记录没有这个字段，也不该因此解析失败——缺了就是一条
   * 没有类型名的注入，行上只写「上下文」。
   */
  contextLabel?: string;
};

export type HistoryEvent = {
  eventId?: string;
  type?: string;
  role?: string;
  content?: string;
  createdAt?: number;
  /*
    `content` 是这条消息拍平成的文本，`data.parts` 才是它的结构。**列表要靠 parts 把一次
    agent 回合渲染成「文本 + 工具调用」，而不是一坨纯文本。**

    可能没有：128KB 以上的消息只存轮廓（仍有 parts），而更早写入的行、以及只有正文才带
    parts 的老数据都可能缺。缺了就退回按 content 渲染。
  */
  data?: { parts?: MessagePart[] };
};

export type HistoryMessage = {
  messageId: string;
  historySeq: number;
  event: HistoryEvent;
  /** 正文是否已落库。preview 状态下 content 可能是截断的。 */
  bodyState: string;
  sourceRevision: number;
};

export type HistoryCoverage = {
  hasGap?: boolean;
  transcriptStatus?: string;
  skippedRecords?: number;
};

export type DeliveryState = "queued" | "dispatching" | "accepted" | "failed" | "uncertain" | "cancelled";

export type Delivery = {
  id: string;
  messageId: string;
  state: DeliveryState;
  /** queued 时说明为什么还没投递：terminal_draft / busy / dialog / 其他。 */
  reason: string | null;
  acceptedNativeMessageId?: string | null;
};
