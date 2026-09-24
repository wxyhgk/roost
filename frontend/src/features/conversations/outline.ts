import type { Item } from "./parts";

/*
  对话目录：每一次提问一个刻度。

  **为什么是「提问」而不是「消息」。** 一次回合里 agent 往往有十几条（调用 → 输出 → 再调用），
  把每条都做成刻度，那就是又一根滚动条，帮不上忙。而人回看长对话时找的是**自己问过什么**
  ——那正好是回合的分界线。这条对话有一万多条消息、四百多次提问，四百个刻度是能扫的。
*/
export type OutlineEntry = {
  /** 在 items 里的下标。跳转要用它，所以不能用 message id 代替。 */
  index: number;
  /** 鼠标停上去时显示哪一句。 */
  label: string;
};

/** 一次提问的摘要：压掉空白、截短。太长的问题在刻度上没法看。 */
const label = (text: string) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
};

export function outlineOf(items: readonly Item[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind !== "text" || item.role !== "user") continue;
    const text = label(item.text);
    // 空的问题不给刻度——点过去什么都没有，只会让人以为点坏了。
    if (text) entries.push({ index, label: text });
  }
  return entries;
}

/**
 * 当前视口对应哪一个刻度。
 *
 * 取「起点不晚于视口顶端的最后一个」——也就是你正在读的这一段属于哪次提问。
 * 视口在第一次提问之前（比如刚翻到很早的历史）时返回 -1，**不要硬选第一个**：
 * 那会让刻度显示成你在读第一次提问，而其实不在。
 */
export function activeOutlineIndex(entries: readonly OutlineEntry[], firstVisible: number): number {
  let active = -1;
  for (const [position, entry] of entries.entries()) {
    if (entry.index > firstVisible) break;
    active = position;
  }
  return active;
}
