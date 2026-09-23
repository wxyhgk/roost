import type { DatabaseSync } from 'node:sqlite';

/** Keep the entire response bounded, without splitting UTF-16 surrogate pairs. */
function preview(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  let result = '', length = 0;
  for (const character of normalized) {
    if (length++ === 120) break;
    result += character;
  }
  return result;
}

export function createConversationPreviews(db: DatabaseSync) {
  // The saved preview is bounded by the history writer; no source-file hydration.
  db.function('roost_user_preview', { deterministic: true }, value => preview(value));
  return (conversationIds: string[]): Map<string, string | null> => {
    if (!conversationIds.length) return new Map();
    // One query for the current page, not one query per item. The first event's
    // original position survives revisions; its newest saved text is displayed.
    /*
      **「只要用户消息」这一条必须下推到最里层。**

      它原来写在 `users` 里，也就是三层窗口函数**算完之后**才过滤。窗口函数因此要把这些
      会话的**每一条消息**都读进来、按 (conversation_id, event_id) 分区排两遍——而真正
      需要的只有那一小撮用户消息。实测这台机器上的真实数据：一页 16 条会话里有两条大的
      （20764 条和 11020 条消息），整条查询 2355ms；下推之后 133ms，**18 倍**，返回结果
      逐字相同。

      这一步是 `/api/conversations` 列表接口慢的主因，而那个接口又占了「打开一条对话」
      整条瀑布的 99%（实测 816ms 里 806ms 在它身上）。更糟的是后端只有一个同步的 sqlite
      连接、跑在主线程上：这条查询跑 470ms，后端这 470ms 什么都做不了——同一时间打
      `/messages` 的 p50 从 1.1ms 涨到 459ms。所以它慢不只是它自己慢。

      **下推成立的前提**：同一条消息的各个修订版不会改变 role 和 type（改的是正文）。
      role 来自转录记录本身的类型，不会从 user 变成别的。真实数据上验过结果一致。

      试过但**没有**采用：给这两个条件建部分索引。实测一点用没有（133ms → 133ms），
      因为剩下的开销在读 `preview_json` 本身，索引不覆盖它——白占写入成本和磁盘。
    */
    const rows = db.prepare(`WITH versions AS (
      SELECT conversation_id,preview_json,
        MIN(seq) OVER (PARTITION BY conversation_id,event_id) AS original_seq,
        FIRST_VALUE(json_extract(preview_json,'$.createdAt')) OVER
          (PARTITION BY conversation_id,event_id ORDER BY seq) AS original_time,
        ROW_NUMBER() OVER (PARTITION BY conversation_id,event_id ORDER BY revision DESC,seq DESC) AS version_rank
      FROM ai_history_messages m WHERE conversation_id IN (${conversationIds.map(() => '?').join(',')})
        AND json_extract(preview_json,'$.role')='user'
        AND json_extract(preview_json,'$.type')='message'
    ), users AS (
      SELECT conversation_id,original_seq,roost_user_preview(json_extract(preview_json,'$.content')) AS text,
        CASE WHEN typeof(original_time)='integer' AND original_time BETWEEN 0 AND 9007199254740991 THEN original_time END AS message_time
      FROM versions WHERE version_rank=1
        AND json_type(preview_json,'$.content')='text'
    ), ordered AS (
      SELECT *, MIN(message_time IS NOT NULL) OVER (PARTITION BY conversation_id) AS has_times
      FROM users WHERE text IS NOT NULL
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY conversation_id
        ORDER BY CASE WHEN has_times THEN message_time ELSE original_seq END,original_seq) AS message_rank
      FROM ordered
    ) SELECT conversation_id,text FROM ranked WHERE message_rank=1`).all(...conversationIds) as { conversation_id: string; text: string }[];
    return new Map(rows.map(row => [row.conversation_id, row.text]));
  };
}
