# 独立对话数据库：ChatGPT / Claude 公开行为调研与本项目设计

核查日期：2026-09-09。依据当前官方在线文档及本仓库源码；云产品持续更新，不以某个模型名称当作软件版本。本文是研究与数据库设计建议，未执行迁移或重启服务。

后续要求补充：Agent 需要按稳定 ID 相互发消息，并同步 TUI/GUI。对应的身份、收件箱、投递回执和运行所有权设计见 [Agent 通讯数据库方案](02-agent-messaging-design.md)。启用通讯之前必须完成 runs；多来源身份还需调整底层旧唯一约束，不能只新增 sources 映射。

## 1. 能确认什么

公开文档能证明产品行为及公开协议，不能证明 ChatGPT / Claude 内部使用哪一种数据库、哪些真实表结构。以下表名、索引和删除策略都是本项目建议，不是厂商内部架构披露。OpenAI Conversations API、Codex App Server、ChatGPT 产品也分别看待。

| 官方资料确认的行为 | 对我们的启发（设计推断） |
| --- | --- |
| ChatGPT 项目组织 chats、sources 和 instructions；支持无项目聊天、聊天重命名、置顶、搜索、归档及恢复归档 | 对话有自己的稳定身份和生命周期；项目归属可选，展示顺序不应由终端实例决定 |
| Claude 聊天可加入、移出或移动到另一项目；项目归档后仍能访问聊天 | 移动项目只改变组织关系；归档不删除正文，也不等同结束进程 |
| Claude 将聊天历史、搜索和 memory 分开说明 | 历史正文、搜索索引、供模型复用的摘要不是同一种数据；第一阶段无需先做向量库 |
| Claude 可导出聊天数据，但个人账号之间不能靠该导出导入迁移 | 可导出、可查看与可恢复运行必须分别标注 |
| OpenAI Conversations API 有可跨 session/device/job 使用的 durable ID，items 可包含消息、工具调用和结果 | 参考持久对话对象与结构化内容的分离；这不证明 ChatGPT 网页内部采用相同存储 |
| Codex App Server 分别提供 thread/read、thread/resume、thread/fork；fork 产生新 thread ID | 查看不应启动 AI；恢复与分叉是不同操作，新执行进程不应必然产生新用户对话 |

来源：

- [ChatGPT Projects and chats](https://learn.chatgpt.com/docs/projects)：项目、聊天、归档、标题、置顶与搜索。
- [Claude 项目管理](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)：聊天移动、项目归档与访问。
- [Claude 聊天搜索与记忆](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)：两种能力的用途与边界；文档含当前与 legacy 说明，不把旧版细节混入当前设计。
- [Claude 删除与重命名](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation)：对话管理与删除语义。
- [Claude 数据导出](https://support.claude.com/en/articles/9450526-export-your-claude-data)：导出内容及不支持个人账号间导入的限制。
- [OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)：durable conversation ID 与结构化 items。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：读取、恢复、分叉及原生执行生命周期。

## 2. 我们当前真正缺的是什么

已经有 SQLite，不需要再搭数据库服务。当前 `packages/workspace-store/src/ai-history.ts` 已建：

- `ai_conversations`：由 CLI 和 native ID 标识的原生对话记录。
- `ai_history_messages` / `ai_history_bodies`：消息预览、修订与耐久正文。
- `ai_generations`：某个网页终端关联原生对话的历史代次。
- `ai_session_replay`：有界事件补收缓存。

但是它们尚未组成独立于终端的用户对话库：

1. `store.ts` 删除终端时调用 `aiSessions.remove()`；后者删除 generations，并在无剩余引用时删除对话与正文。终端崩溃本身不等于立即删库，但手动删除终端记录可能把最后一份历史一起清掉。
2. `HistoryStore` 仍主要用 webSessionId + generation 查询。终端不存在后缺少直接按独立 conversation ID 列表、搜索和读正文的 API。
3. `ai_conversations` 缺少用户标题、项目归属、归档时间等列表元数据。
4. 当前原生身份摘要使用 [local, cliId, nativeSessionId]；它没有完整表达不同机器、不同 CLI 数据根或独立服务器的身份命名空间。
5. Binding 保存的 PID/instance、临时端口、transcript 路径不是永久恢复保证。例如 OpenCode 随 TUI 退出的旧端口失效后，不能当作新的恢复入口直接复用。

## 3. 建议的所有权模型

```text
项目（可为空）
  └─ 用户对话：长期 ID、标题、归档状态
       ├─ 原生来源：CLI + 身份命名空间 + native ID
       │    └─ 已保存消息、工具结果、修订、读取覆盖情况
       └─ 运行记录：本次由哪个 daemon / 终端 / 进程承载
```

同一段原生对话重开终端，仍是同一个用户对话。切换到另一条原生对话，找到它对应的用户对话，不把正文并进当前对话。fork 或换提供商时默认创建新对话并记录来源关系，不以“继续”名义悄悄拼接两个原生上下文。

对话的 active/archived/trashed 是用户整理状态；运行记录的 running/exited/interrupted 是执行状态。不要用一个 status 字段同时表达两类含义。

## 4. 数据库第一阶段：兼容现有表的增量路线

建议保留当前消息表与历史 ID，在上面增加用户目录与来源映射。避免第一步就重写全部旧主键、改掉现有 generation API。

### conversation_catalog（新增）

用户可在 GUI 中独立管理的对象：

- `id`：应用生成的稳定 UUID，不依赖 PID、端口或终端 ID。
- `title`、`title_origin`：用户改名后不被后来自动标题覆盖。
- `project_id`：可空；项目被删除时解除归属，默认保留对话。
- `created_at`、`updated_at`、`last_message_at`：重命名或打开历史不冒充新回复。
- `archived_at`、`trashed_at`、`pinned_at`、`revision`。
- 可选 `forked_from_id`：只记录明确分叉关系，首轮不实现复杂消息树编辑。

### conversation_sources（新增）

连接用户对话与现有原生记录：

- `id`、`conversation_id`、`legacy_conversation_id`。
- `cli_id`、`origin_scope`、`native_session_id`。
- `cwd`、`source_kind`、`source_locator_json`、`adapter_version`。
- `last_observed_at`、`last_validated_at`、`coverage_json`。

关键约束：唯一 `(origin_scope, cli_id, native_session_id)`，一个原生来源只能归属一条用户对话。CLI 的模型供应商不是 cli_id。当前只建立明确的一对一来源关系；不自动把不同 CLI 的对话合并。

origin_scope 应由后端配置的稳定执行环境/CLI 存储空间标识构成，不能取每次随机变化的端口，也不能只取 cwd。旧数据来源不明时标为 legacy/unknown，不猜机器身份或宣称可恢复。

source_locator_json 分版本保存已验证的文件/存储信息；不保存 API key、会话 cookie、临时鉴权 token 或可直接执行的任意 shell 字符串。未来恢复由可信适配器构造 argv。

### 运行记录（第二阶段添加）

建议 `conversation_runs` 保存 conversation/source、terminal ID、terminal instance、daemon instance、开始/结束时间、退出原因及恢复请求 ID。删除终端仅解除运行关联，保留运行摘要及对话。当前 generations 继续作为同步历史边界，不强行改名当作一次 AI 回合。

第一阶段无需抢先创建空的执行管理系统；先完成 catalog/sources 与独立历史查询，再落地 runs 和恢复事务。

## 5. 删除、归档和恢复的明确约定

- 终端退出：关闭运行关系，不删除消息。
- 删除终端：清理 PTY replay 等临时数据；保留对话、来源和已有耐久正文，不因“最后一个终端引用消失”而清理历史。
- 删除项目：对话默认移为未分组。项目文件夹是否删除是独立的文件操作。
- 归档对话：从默认列表隐藏，仍能搜索/查看/取消归档。
- 移入回收站：可撤销的整理操作。永久删除是独立操作，删除搜索索引和正文；默认不替用户删除 CLI 原生文件。
- 点击历史：只读，不启动模型或恢复工具执行。
- 点击继续：重新检查原生状态；活着就连接，退出才通过适配器恢复。不能仅凭数据库缓存的 running 状态或某个 PID 判断。

不复制云产品的具体留存天数到本地工具。我们先实现明确的用户删除边界与一致性，不增加自动到期清理。

## 6. 首批 API（建议，尚未实现）

- `GET /api/conversations?projectId=&q=&state=&cursor=&limit=`：独立目录，返回预览与覆盖情况，不全量加载正文。
- `GET /api/conversations/:id`：用户元数据与原生来源摘要。
- `GET /api/conversations/:id/messages?cursor=&limit=`：即使终端已不存在也能分页读取；保留当前消息修订和不完整记录标记。
- `PATCH /api/conversations/:id`：title、projectId、归档/置顶等，revision 防多窗口覆盖。

第一阶段搜索先覆盖标题与已存文本，并说明不能搜索尚未采集的消息；普通全文检索可用 SQLite FTS5，不先引入向量数据库。FTS5 只是派生索引，可重建，不能成为唯一正文来源。

恢复接口第二阶段再定义。将来返回 readable、resume capability 和不可恢复原因三种独立信息；capability 缓存仅用于展示，执行前必须重验。

## 7. 迁移与验收

先做一致性备份，使用 SQLite 备份能力，而不是在 WAL 活跃时只复制主文件。新增 schema marker，事务中为每个已有原生对话创建一个 catalog 和 source，保留原消息 ID、历史序号、generation 与旧 API 可用。迁移重试不得创建重复目录行。

修改终端删除逻辑必须与迁移同步交付：不能目录迁好了，旧 remove 路径仍把底层正文删掉。若历史 generation 查询需要原记录，保留对应离线元数据直到新旧入口均迁移；只解除 live binding，不通过删除历史来表达解绑。

第一阶段验收：

1. 已有多条 CLI 对话迁移后数量和正文不变，重复打开库不重复导入。
2. 删除承载对话的最后一个终端，GUI 列表与消息分页仍可读。
3. daemon 未启动时仍能列出、搜索和查看已存正文。
4. 同 native ID 来自不同明确 origin 时不合并；同来源重新关联新终端不复制一条对话。
5. 原生文件失效时，已存正文仍可查看，并明确历史可能不完整、恢复待验证。
6. 归档/恢复归档不改变消息；元数据 revision 冲突返回 409。
7. 崩溃中断迁移后可以重试，旧 API 不误读到其他会话。

随后再做每种 CLI 的恢复：身份校验、运行锁与请求幂等、恢复失败留在原对话、未确认提交不自动重发。数据库完成不代表这些执行协议已经完成。

## 8. 本轮交付范围

完成官方资料调研、当前删除/身份/消息表源码核对及增量设计。没有读取用户私人对话内容，没有修改数据库或业务代码，没有重启 daemon。建议下一批直接实施第 4—7 节的第一阶段，先实现“终端不存在，历史仍可独立访问”。
