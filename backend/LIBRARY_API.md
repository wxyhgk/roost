# 笔记与代码片段 API（已实现合同）

实现位置：`@roost/workspace-store` 的 `library` 领域方法，以及 `backend/src/library.ts`。
数据是同一后端资料库下的全局资料，不依赖项目或终端，不进入 `/api/workspace`。
前端接入、草稿备份、自动保存和迁移操作界面仍由前端实现。

## 记录与逐条操作

两类完整记录共有 `id, revision, createdAt, updatedAt, deletedAt`（活跃记录 deletedAt=null）。
笔记增加 `text`；片段增加 `title, lang, code`。时间单位为 Unix 毫秒。

```
POST /api/notes
{"id":"12345678-1234-4234-8234-123456789abc","text":"第一行标题\n正文"}

PATCH /api/notes/12345678-1234-4234-8234-123456789abc
{"revision":1,"text":"更新后的正文"}

DELETE /api/notes/12345678-1234-4234-8234-123456789abc
{"revision":2}
```

- 普通 POST 必须提供客户端 UUID 和 `text`；片段必须提供 UUID、`title`、`code`，
  `lang` 可省略（plaintext）。允许空正文和空标题。首次创建返回 201，revision=1。
- POST 同 ID 同内容重试返回 200 和当前记录；内容不同返回 409 `id_conflict`；
  遇到墓碑返回 410 `deleted`。内容比较包含片段 title/lang/code，不比较时间。
- GET `/api/notes/:id`、`/api/snippets/:id` 返回完整记录。
- PATCH 要求 revision 和至少一个对应的内容字段，仅更新明确提供的字段。
  成功返回 200 完整记录，revision 加一。未知字段、null、id/时间修改、空 PATCH 均为 400。
- DELETE 要求 revision，成功返回 `{id,revision,deletedAt}`。删除递增 revision，
  已删除记录的重试返回原墓碑（仍需合法 revision），不重复递增。
- 普通创建/修改时间由服务器生成；修改不让 updatedAt 倒退，并发判断只使用 revision。
- GET/PATCH 已删除记录返回 410，未知 ID 返回 404。墓碑永久保留，首期不做恢复/清除。
- POST 普通 ID 必须符合 UUID 字符格式；详情/PATCH/DELETE 兼容迁移旧 ID。

## 列表、搜索与分页

```
GET /api/notes?limit=50&q=中文
GET /api/snippets?limit=50&q=python
```

返回 `{items,nextCursor}`。items 只含 `id,title,summary,createdAt,updatedAt,revision`，
片段另含 `lang`。summary 最多 160 个字符，笔记 title 为首个非空行（最多 256 字符）。
不返回 text/code，点击条目再 GET 正文。隐藏墓碑，按 updatedAt DESC、id DESC 排序。

limit 默认 50，合法范围 1..100（不静默截断），nextCursor=null 表示没有下一页。
游标作为不透明字符串原样回传；绑定资源类型和精确 q，可改变 limit。
非法/跨资源/不同筛选条件的游标返回 400。查询参数不允许重复或未知键。
数据持续变动时可能需要重新加载，不提供快照分页。

搜索为参数化子串匹配：notes.text；snippets.title/code。
`%`、`_`、反斜线作为普通字符。ASCII 英文大小写不敏感；中文按原字符匹配，
不做分词或 Unicode 大小写折叠。

## 体积与错误

正文最多 1 MiB **UTF-8 字节**，title 最多 256 字符，lang 最多 64 字符，q 最多 200 字符。
lang 接受 ASCII 字母、数字及 `_+.#-`，不限于当前前端选项；未知语言由前端回退。
普通记录编码请求体上限为 6 MiB + 64 KiB，给 JSON 转义留余量；解码后再查正文大小。

错误统一为：

```json
{"error":{"code":"revision_conflict","message":"record changed since it was read"},"current":{"id":"…","text":"远端内容","revision":2,"createdAt":1,"updatedAt":2,"deletedAt":null}}
```

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | invalid_request | 字段、ID、revision、游标或批次格式无效 |
| 404 | not_found | 未知记录 |
| 409 | revision_conflict / id_conflict / batch_conflict | 编辑版本、创建 ID 或导入批次冲突 |
| 410 | deleted | 已删除，不自动复活 |
| 413 | too_large | 字段、请求或批次数量超限 |
| 503 | storage_unavailable | SQLite busy/locked/readonly/I/O/full/cannot-open |
| 500 | internal_error | 其他写入/内部失败，不能显示保存成功 |
| 405 | method_not_allowed | 不支持的操作 |

记录 409 和 410 提供 current，批次冲突不含 current。原有 Host/Origin 访问检查先于路由，
其 403 仍可能是纯文本。前端应兼容这一已有错误格式。

UPDATE 使用 `WHERE id=? AND revision=? AND deleted_at IS NULL`，SQL 原子递增版本；
删除同样做条件写入。响应丢失后 PATCH 重试可能 409，前端对比 current 与本次目标内容，
相同可认为此前已保存；不相同保留草稿提示冲突，不能无条件覆盖。

## 旧浏览器数据导入

`GET /api/library/info` 返回 `{libraryId}`。稳定 ID 在建库迁移时生成，保存在 meta；
后端重启保持不变，前端按这个 ID 记录迁移进度。

```
POST /api/library/import
{
  "sourceId":"browser-1",
  "batchId":"batch-1",
  "notes":[{"id":"old-note-1","text":"旧内容","createdAt":123,"updatedAt":456}],
  "snippets":[{"id":"old-snippet-1","title":"命令","code":"pwd","lang":"bash"}]
}
```

notes/snippets 两个数组必填，总计最多 100 条，编码请求体最多 8 MiB，单条限制不变。
ID/sourceId/batchId 为 1..128 位 ASCII 字母、数字、`._:-`，首位为字母或数字。
兼容当前 UUID 和旧随机 ID。同类数组重复 ID 返回 400；跨两种资源允许同 ID。

返回 200：

```json
{"libraryId":"…","sourceId":"browser-1","batchId":"batch-1","notes":[{"id":"old-note-1","status":"created","revision":1}],"snippets":[{"id":"old-snippet-1","status":"existing","revision":2}]}
```

逐条 status 为 created / existing / conflict / deleted。deleted 另含 deletedAt。
响应只提供目标 ID、状态和 revision，不复制正文；冲突详情按 ID GET 查询。
同 ID 同内容 existing，异内容 conflict 且不覆盖服务器；墓碑 deleted 且不复活。
不同 ID 同正文保持两份，不做内容去重。

有效旧时间（正安全整数且在 JS 日期范围内）保留，其他值或缺失回退本批服务器时间。
createdAt/updatedAt 独立校验，不根据浏览器时间决定覆盖顺序。

账本按 `(sourceId,batchId)` 唯一，保存规范化 JSON 哈希和原始逐条结果，与内容在同一事务提交。
JSON 对象字段顺序不影响哈希；条目顺序、字段内容或时间变化视为批次内容变化。
原批次重试返回原结果，即使记录后来又被编辑/删除；不要用导入结果替换较新的编辑状态。
相同批次 ID 改内容返回 409 batch_conflict。格式错误包含 `notes[1].text` 等位置，
整批不写入；写入/账本失败也整批回滚。修正失败批次后可重试；已提交的批次须换 batchId。

## 前端交接与上线

迁移前保留 `diy-notes-v1` 原始 JSON 备份；按 libraryId/sourceId/batchId 记录进度，
确认成功后停止旧 key 双写，保留备份。未解决的冲突、超限数据和失败草稿允许重试/导出。
NotesView、SelectionSaveBar、CommandPalette 使用同一资料数据层。

按条目串行防抖保存（约 500ms，最长约 2s），成功响应后更新 revision；期间新增编辑
进入下一次请求。明确显示未保存/保存中/成功/失败/冲突，断线草稿留在浏览器。
首期无推送：打开面板或窗口聚焦时刷新，脏编辑器不能被远端内容直接覆盖。

schema.library.v1 在现有 schema 事务内建立两张内容表和一张导入账本表，不改会话/replay 表。
数据库迁移在下次后端打开 workspace-store 时运行。此交付仅使用临时数据库验证，
未操作当前浏览器数据，也未停止当前 HTTP 服务、PTY 或终端守护进程。
