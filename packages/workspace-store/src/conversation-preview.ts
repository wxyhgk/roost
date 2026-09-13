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
    const rows = db.prepare(`WITH versions AS (
      SELECT conversation_id,preview_json,
        MIN(seq) OVER (PARTITION BY conversation_id,event_id) AS original_seq,
        FIRST_VALUE(json_extract(preview_json,'$.createdAt')) OVER
          (PARTITION BY conversation_id,event_id ORDER BY seq) AS original_time,
        ROW_NUMBER() OVER (PARTITION BY conversation_id,event_id ORDER BY revision DESC,seq DESC) AS version_rank
      FROM ai_history_messages m WHERE conversation_id IN (${conversationIds.map(() => '?').join(',')})
    ), users AS (
      SELECT conversation_id,original_seq,roost_user_preview(json_extract(preview_json,'$.content')) AS text,
        CASE WHEN typeof(original_time)='integer' AND original_time BETWEEN 0 AND 9007199254740991 THEN original_time END AS message_time
      FROM versions WHERE version_rank=1 AND json_extract(preview_json,'$.role')='user'
        AND json_extract(preview_json,'$.type')='message'
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
