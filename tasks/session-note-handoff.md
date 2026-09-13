# 会话备注（`note`）—— 后端交接

后端实施契约与验证记录见 [session-note/README.md](session-note/README.md)。以下保留原始需求。

## 要什么

给每个终端会话挂一段用户自己写的短备注，显示在画布卡片和会话行上。用途是
「这个终端是干嘛的」——`title` 太短说不清，cwd 又是机器给的。

**只要一个可空的自由文本字段，不要富文本、不要历史版本、不要多条。**
已有的 `notes` 库（`library-records`）是独立的知识库条目，和会话没有关联，
不复用它：那是「我记下来的东西」，这是「这张卡是什么」，生命周期跟着会话走。

## 落点（四处，与 `title` 完全同形）

1. **`packages/workspace-store/src/database.ts`** —— 加一次列迁移。照抄
   `terminal_replay.state_json` 那段（`:59-63`）的写法，老库不能重建：

   ```ts
   const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
   if (!sessionColumns.some(c => c.name === "note")) {
     db.exec("ALTER TABLE sessions ADD COLUMN note TEXT");
   }
   ```

   `CREATE TABLE IF NOT EXISTS sessions` 那段也一并加上 `note TEXT`，新库直接带。

2. **`packages/workspace-store/src/types.ts`** —— `SessionRecord` 加
   `note: string | null`。

3. **`packages/workspace-store/src/sessions.ts`** —— `mapSession` 带上它
   （`row.note ?? null`），三处 `SELECT` 的列清单加 `note`，并加
   `setSessionNote(id, note: string | null)`，与 `setSessionTitle`（`:99`）同形。

4. **`backend/src/server.ts:403` 的 `PATCH /api/sessions/:id`** —— 加一个分支，
   放在 `title` 那段旁边：

   ```ts
   if ("note" in body) {
     if (body.note !== null && typeof body.note !== "string") {
       throw new HttpInputError(400, "note must be a string or null");
     }
     const note = typeof body.note === "string" ? body.note.trim() : "";
     setSessionNote(id, note || null);   // 空串归一成 null
   }
   ```

## 三个必须照做的点

- **`""` 和 `null` 要归一。** 用户把备注删空，存进去必须是 `null`，不是空串。
  否则前端得同时判两种「没有」，迟早漏一种。

- **`title` 是 `if (title) setSessionTitle(...)`——空串静默忽略，这对标题是对的
  （会话不能没有名字），但对 `note` 是错的**：清空备注是一个合法操作，不能被
  当成「没传」吃掉。所以上面用 `"note" in body` 判断存在性，不是判真值。

- **长度要有上限**，建议 2000 字符，超了返 400 而不是截断。截断会让用户以为存住了。
  没有上限的话，这个字段会跟着 `WorkspaceSnapshot` 在每次 hydrate 时全量下发
  （`store.ts` 4 秒轮询一次），几十个会话各塞一篇文章就变成持续的带宽负担。

## 验收

- `backend/tests/` 加一条：PATCH 写入 note → 重新 `createWorkspaceStore` 打开同一
  `dataDir` → 快照里还在。写法照 `cli-configs.test.ts:34-35`。
- 回归性检查：把第 4 点的分支去掉，该测试必须失败，否则不算数。
- 老库迁移：拿一个**升级前**建的 `workspace.sqlite` 打开，不能报错，
  且所有会话的 `note` 读出来是 `null`。

## 前端这边

`renameSession` 那条路已经跑通了（`store.ts:220`，走 `PATCH {title}`），
`note` 接上之后照抄一个 `setSessionNote` 即可，不需要别的接口。
画布卡片和会话行都已经在用同一份 `sessionBadge`，加显示的位置也只有一处。
