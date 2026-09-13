# 笔记与代码片段持久化：后端交接设计

日期：2026-09-07。状态：设计建议，尚未实现；本次只新增文档，不操作数据库或重启服务。

## 结论与当前证据

建议接入后端 SQLite，复用 `${dataDir}/workspace.sqlite` 和 `@roost/workspace-store`，新增 `notes`、`snippets` 两张表。当前是同一后端工作区的个人资料库，所有连接该后端的设备共享；不是按浏览器隔离，也不是多用户私有空间。

- `frontend/src/notes.ts`：两类数据一起存于 `diy-notes-v1` localStorage；`saveNotes` 捕获写入失败后静默返回。
- `frontend/src/components/NotesView.tsx`：挂载时加载集合，编辑后全量写回。不同视图持有旧集合时存在覆盖其他新增内容的风险。
- `frontend/src/components/SelectionSaveBar.tsx`：终端选区保存也是读整个集合后写回；保存失败仍可能显示成功。
- `frontend/src/components/CommandPalette.tsx`：独立从 localStorage 读取笔记和片段，接入时也必须改。
- `packages/workspace-store/src/database.ts`：已有 node:sqlite、workspace.sqlite、WAL、5 秒 busy_timeout 与事务封装。
- `packages/workspace-store/src/store.ts`：已有领域模块组合方式。建议分别加 notes.ts、snippets.ts，由公共入口导出方法；后端负责 HTTP 校验，前端不接触 SQLite。

SQLite 适合这种由本机后端管理的应用数据。WAL 可以让读写并行，但同时仍只有一个写事务，因此自动保存要合并请求、批量迁移要分批短事务。[官方适用场景](https://www.sqlite.org/whentouse.html)、[WAL 并发说明](https://www.sqlite.org/wal.html)。

## 首期范围与归属

保持现有产品行为：笔记、片段都是全局资料，不随选中的终端会话变化。发送到当前终端是操作，不意味着资料属于该会话。

首期不增加项目/会话外键，不随删除会话或项目删除资料。以后真正需要项目筛选时，再增加关联表；终端来源信息也应作为可选元数据。不要直接用 cwd 作为资料所属主键。

不合并进 `/api/workspace` 的全量快照，也不把数据存进 meta 的一个 JSON 字段。正文独立加载、逐条更新。首期不做协同编辑、全文搜索引擎、标签体系或版本历史；冲突保护和删除墓碑先做。

## 建议表结构

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX notes_active_updated
  ON notes(updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'plaintext',
  code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX snippets_active_updated
  ON snippets(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
```

- API 保留现有字段名 `text` / `title` / `lang` / `code` / `createdAt` / `updatedAt`，新增 `revision`。笔记标题继续由首个非空行派生，无须增加独立编辑字段。
- 普通新增/修改的时间由服务端生成，单位 Unix 毫秒；排序并列用 ID 保证确定性。并发判断只用 revision。
- ID 接受客户端生成的 UUID；迁移入口兼容当前旧 ID 格式。限制长度与字符，不从 ID 拼 SQL；所有值参数化。
- 两表分开使约束、接口和现有模型直接对应。首期允许空正文、空标题，保留新建后再输入的体验。
- `lang` 建议接受有长度限制的语言标识；未知语言前端回退 plaintext，不把后端永久限制在当前七个选项。
- 删除采用墓碑并递增 revision，避免旧设备上传时把已删除资料重新创建。首期不自动清除墓碑，回收站 UI 后续再做。
- 通过可重复启动的增量 schema migration 建表，使用独立迁移标识；不重建已有表，不改会话、replay 的数据结构。

## API 契约

以下是建议合同，后端实现时固定并写入测试。两组资源使用同样规则。

| 方法与路径 | 行为 |
| --- | --- |
| GET `/api/notes?limit=50&cursor=...&q=...` | 返回 `{items,nextCursor}`，只含 ID、派生标题、摘要、时间、revision，不批量返回完整正文 |
| POST `/api/notes` | `{id,text}`；201 返回完整记录 |
| GET `/api/notes/:id` | 返回完整记录 |
| PATCH `/api/notes/:id` | `{revision,text}`；200 返回保存后的完整记录 |
| DELETE `/api/notes/:id` | JSON `{revision}`；成功返回 `{id,revision,deletedAt}` |
| `/api/snippets` 及 `/:id` | 同上；创建/修改字段为 title、lang、code，列表额外包含 lang |

建议限制：正文每条最多 1 MiB UTF-8，标题 256 字符，lang 64 字符，q 200 字符；limit 默认 50、最大 100。请求体字节上限要给 JSON 编码留余量，正文解码后再校验实际大小；超限返回 413。首期使用参数化子串搜索：笔记 text，片段 title/code，正确转义 LIKE 的 `%`、`_`；英文大小写语义写入测试，中文不依赖分词。列表按 updatedAt DESC、id DESC 游标分页，游标校验且绑定过滤条件；列表持续变动时允许重新加载，不宣称快照分页。

错误格式建议 `{error:{code,message},current?}`：400 无效字段/版本缺失，404 未知 ID，409 版本或 ID 冲突，410 已删除，413 超限，503 数据库忙/暂时不可写。普通创建遇到已有 ID：内容相同返回现有记录（200，便于首次创建超时后重试），不同返回 409；遇到墓碑返回 410，不复活。

### 防止覆盖是必做项

更新执行原子条件 SQL：`UPDATE ... SET ..., revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL`。不能先查版本、脱离事务后再无条件写入。未更新时区分不存在、已删除、版本冲突；409 返回当前完整记录供前端比较。

PATCH 只更新明确提供的字段；拒绝未知字段、null 和修改 id/createdAt。DELETE 同样校验 revision；已删除可返回现有墓碑，实现删除重试。数据库提交成功后才返回成功。

写成功但响应丢失时，旧 revision 重试可能收到 409；前端读取 current 对比本次目标内容，相同可确认已保存，不同保留本地草稿提示冲突。不得无条件覆盖远端版本。

## 旧 localStorage 迁移

后端无法直接读取浏览器数据，需要前端调用专门的导入接口。

建议 POST `/api/library/import`，请求 `{sourceId,batchId,notes:[],snippets:[]}`，每批不超过 100 条及 8 MiB 编码请求体。返回逐条 `created/existing/conflict/deleted` 和目标 ID；格式错误返回明确条目位置，整批不提交。首期限制单条大小仍适用，超限旧数据保留本地并支持导出，不能静默截断。

- 增加导入账本，至少保存 `(source_id,batch_id)` 唯一键、请求内容哈希、逐条结果。记录和账本在同一事务提交；同一 batchId 内容变化返回 409，重试原批次返回原结果。
- 保留旧 ID 与有效的旧时间；缺失/非法时间回退服务端时间。相同 ID、相同内容跳过；相同 ID、不同内容保留服务器版本并返回 conflict，不能按浏览器时间做最后写入获胜。
- 已有墓碑返回 deleted，不自动恢复；冲突内容让用户查看或另存新 ID。不同 ID 即便正文相同也不强制去重，用户可能刻意保存两份。
- 前端先保留原始 JSON 备份，再导入。逐批确认后记录结果；网络中断可以安全重试。sourceId 只是迁移来源标识，不是用户身份。
- 导入完成标志要绑定服务端资料库 ID（可在 meta 存稳定 libraryId，由 GET `/api/library/info` 返回），不能用浏览器单一 migrated=true，避免切换后端后误判。
- 切换至 API 后，旧 key 只作为恢复备份，不再双写；不要立刻删除。未解决的冲突/失败要显示出来，允许重试或导出。

## 前端接入合同（后端人员不必改 UI，但接口要支持）

1. 一个共享的 library 数据层连接 NotesView、SelectionSaveBar、CommandPalette；逐条 mutation 后失效相关列表缓存。替换 RightPanel 的“存于本机浏览器”说明。
2. 自动保存按条目约 500ms 防抖、最多约 2 秒触发；同一条目一次只发一个请求，其间新输入排入下一次保存，使用最新返回 revision。旧请求返回不能覆盖用户更新的草稿或当前选择。
3. 显示未保存/保存中/已保存/失败/冲突。选区存储只有服务端成功后显示已保存；失败保留文本和重试入口。
4. 切换条目时提交待保存内容并保留草稿；断网/关闭页面前在本地存待同步草稿，不依赖 beforeunload 网络请求。重连后必须按 revision 检查，不能把草稿直接盖到数据库。
5. 首期打开面板和窗口重新聚焦时刷新列表；干净条目可更新，正在编辑的条目保留草稿并提示远端变化。暂不要求 SSE/WebSocket，跨设备变化不是即时推送。
6. 编辑器当前按 filename 创建且不主动同步外部 code：接入后需明确在干净状态更新编辑器内容，在脏状态走冲突流程，不能只替换 React state。

## 后端交付与验收

- 负责 `packages/workspace-store/**` 的表迁移、领域方法、测试，以及 `backend/**` HTTP 接口和集成测试；前端接入另行安排。
- 先给出接口示例、错误码、导入合同；不得提供整库覆盖式 PUT 接口。
- 验证新库/已有库/重复启动迁移；关闭后重开数据保持；既有 sessions/projects/replay 数据不变。
- 两客户端拿同一 revision 修改时，仅一方成功；另一方 409 且原草稿可恢复。覆盖删除与更新竞争、响应丢失后的重试。
- 导入重试无重复；同 ID 异内容不覆盖；已删除不复活；失败批次原子回滚；非法时间和超限旧数据有明确结果。
- 验证中文、多行代码、空正文、语言回退、搜索通配符、排序并列、分页、请求限制、数据库忙和写失败。
- 在临时 dataDir 跑后端与 store 测试，再跑项目 verify；开发中的服务加载与数据库迁移安排独立交接，不停止当前 PTY 或 daemon。

后续有实际需求再做：项目关联、回收站、导出、历史版本、FTS、实时推送、多用户隔离。当前优先保证数据可靠保存、设备间可访问以及冲突可恢复。
