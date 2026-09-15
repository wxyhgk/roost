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
};

/**
 * 一次模型请求的 token 用量。供应商上报，后端（`packages/ai-transcript`）折好带过来。
 *
 * **可选的三个桶缺席 ≠ 0。** 供应商没报缓存读写或思考 token 时，那个字段整个不出现——
 * 求和的时候必须跟着缺席，而不是补一个 0 进去。补 0 会得到一个看着完整、其实少算的总数，
 * 而少算在界面上看不出来。折一个回合的用量时：只要这个回合里有一条消息缺了某个桶，
 * 整个回合的那个桶就不显示。
 *
 * `inputTokens` 是**没命中缓存的**那部分输入，不含 `cacheReadTokens` / `cacheWriteTokens`；
 * 所以总数是四项相加。`reasoningTokens` 是 `outputTokens` 的子集，**不另加**。
 */
export type MessageUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  model?: string;
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
  /*
    `usage` 是**消息级**的，不在 `parts` 里：它描述的是产生这条回复的那一次模型请求，
    而不是回复里的某一段。只有 assistant 消息有；工具结果那些记录没有自己的请求。
    老数据、不支持的 CLI 都会缺——缺了就是没有这个数，不要估。
  */
  data?: { parts?: MessagePart[]; usage?: MessageUsage };
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
