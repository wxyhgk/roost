# G1 实施范围与升级约定

日期：2026-09-09。状态：G1 实现与本批自动化验收完成；未部署到日常服务。独立测试和反方记录见下文。

## 本批交付

- 独立 catalog 与 source 映射，稳定 conversationId；原有正文与 generation ID 保持。
- 不依赖活跃终端的列表、详情、保存正文分页和元数据编辑；搜索标题及已保存正文的 content，未存完整正文时回退预览。普通无搜索列表不加载完整正文。
- 删除终端只清临时终端状态，保留历史与原生接收回执；待发送 command 取消，已经进入写入阶段的保守标为 uncertain。
- 增量迁移、旧写入者保护、显式一致性备份工具。

本批没有 Agent 发信、run 接管、收件箱、GUI changes 或 CLI 恢复接口；不宣称 A/B/C 通讯完成。下一批在本批通过后实施。

## 固定的契约与范围

1. 本批仅支持已有本地来源，source 明确标 `legacy-local`、定位信息 unverified；不开放传入 origin_scope，不将不同来源猜测合并。R2 的全链路多来源迁移仍待下一批完成，不能通过新 sources 表宣称已经支持。
2. 第一版 source 与 catalog 一对一。原生会话重新绑定沿用 catalog UUID，终端显示名不作为身份。
3. 仅提供元数据软删除（回收站）、归档与恢复，不提供永久删除。跨对话通讯证据的永久清理规则留通讯批次固定。
4. 元数据更新要求 revision，冲突返回 409 与 current record。点击历史和读取正文不会触发原生进程或源文件读取；未完整保存的正文明确保持 source_backed/unavailable。
5. 旧 history API 的 native conversationId 不改名冒充新 catalog UUID。新独立 API 使用 catalog UUID，source 映射保留旧 ID；前端按交接文档区分。

## 升级门禁

新 AI storage 连接注册 `diy_conversation_writer_v1()`，迁移与版本触发器在同一事务内完成。bridge 存储格式更新为 3；旧格式 2 写入拒绝。历史/来源/目录等写入和删除的触发器检查连接能力，旧连接没有函数时 fail closed；删除 command 的旧路径也被拦截。

这是版本兼容机制，不是凭函数名实现身份认证。旧 daemon 仍能做兼容的原有操作，但旧 gateway 的结构化历史写入会被拒绝；升级不能宣称完全透明。日常服务部署时需要先备份，再安排匹配版本的 gateway/daemon 升级，不应长时间让被拒写的旧采集器继续运行。

测试必须保留一个迁移前打开的旧连接并执行预先 prepare 的旧 DELETE/写入，证明失败且外层事务回滚，不能只测新连接。

`transaction()` 的顶层保留 BEGIN IMMEDIATE，已在事务内的调用使用独立 savepoint，避免命令失效处理嵌套 BEGIN 失败；外层删除失败仍须回滚 command 状态。

## 备份与部署

提供 `scripts/conversation-database-backup.mjs`，显式传入目录和输出文件：

```sh
node scripts/conversation-database-backup.mjs --data-dir <应用数据目录> --output <新的备份文件.sqlite>
```

工具使用 SQLite backup 读取已提交 WAL 数据，不调用 workspace-store 或执行迁移；备份完成后检查完整性，再发布输出文件，已有输出文件不覆盖。备份不是自动恢复/降级方案；目前没有数据库热恢复接口。

本轮开发只在临时目录执行迁移与备份验收，没有运行上述命令处理用户日常数据库。新代码打开库时会执行迁移；部署前必须先完成备份及本批验收。没有自动重启日常服务。

## 文件所有权

- 数据库实现：`conversations.ts`、`conversation-types.ts`、`conversation-schema.ts`、`ai-history.ts`、`ai-sessions.ts`。
- API 实现：`backend/src/conversations.ts`、前端契约文档。
- 独立测试：新 conversations 测试与旧 history/command 删除语义回归。
- 主 Agent：store/index/server 集成、可组合事务、command 删除保护、备份工具和阶段记录。
- 独立反方：实际升级门禁与最终实现审查，报告放 `verification/g1-skeptic.md`。

## 实际验收结果

- 独立测试：workspace-store 52 通过；backend 159 通过、5 跳过；新增目录/HTTP 专项最终复验 14 通过（已包含于上述回归，不重复计数）。见 [独立测试记录](verification/g1-tests.md)。
- 主 Agent 集成回归：`npm test --workspace @roost/terminal-daemon`，34 通过、2 跳过、0 失败，日志 `/tmp/conversation-g1-daemon-tests.log`；workspace-store、terminal-daemon、backend 类型检查及 `node scripts/check-boundaries.mjs` 通过。
- 独立反方实际复测：旧连接写入/删除保护、旧项目删除、完整已保存正文尾部搜索、真实子进程并发 revision 更新。详细场景和限制见 [反方验证记录](verification/g1-skeptic.md)。
- 全部测试为临时数据目录或合成数据。没有执行真实模型请求、GUI 浏览器验收、完整旧 daemon 升级演练或用户日常数据库迁移。迁移失败测试是 SQL 故障回滚重试，不冒充断电恢复实测。

前端可按 [G1 API 契约](07-frontend-contract.md) 对接独立历史。本批尚无 Agent 收件箱、发信、运行恢复和 changes；这些仍按 G2/G3 的独立测试与反方关卡推进。
