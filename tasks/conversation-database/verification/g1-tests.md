# G1 独立测试结果

日期：2026-09-09。测试负责人：database_test_review Agent；实现分别由 store、HTTP 和协调 Agent 完成。运行环境 Node v25.9.0，本地共享 dirty checkout；结果仅针对本轮文件状态，不表示某个已提交版本已发布。

## 结果

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| workspace-store 全量 | 52 通过，0 失败，0 跳过；退出码 0 | `/tmp/g1-store-full.log` |
| backend 全量 | 159 通过，0 失败，5 显式 opt-in 跳过；共 164，退出码 0 | `/tmp/g1-backend-full.log` |
| 新 conversations 测试最终专项 | store 9 + HTTP 5，共 14 通过；退出码 0 | `/tmp/g1-new-tests-final.log`；含最终追加的全文尾部搜索反例 |
| workspace-store 类型检查 | 通过，退出码 0 | `npm run typecheck --workspace @roost/workspace-store` |
| backend 类型检查 | 通过，退出码 0 | `npm run typecheck --workspace backend` |
| 源码边界 | 通过，退出码 0 | `node scripts/check-boundaries.mjs` |
| 本测试文件 whitespace 检查 | 通过 | `git diff --check`，限定本轮测试文件 |

临时 `/tmp` 日志不是长期归档承诺。可复现的测试源码及以下断言是本报告的主要证据；完整仓库状态由协调者最终整合检查。

## 测试代码与实际覆盖

- `packages/workspace-store/tests/conversations.test.ts`：9 个独立用例。直接构造旧 storageFormat 2 SQLite schema，而不是调用新 store 伪造旧库；检查 UUID、旧 message ID、修订、正文、source_backed、coverage 和重复升级。保留原 SQLite 连接跨升级，验证旧 prepared UPDATE/DELETE 被拒绝，command 回执不会被旧删除者清理；即使注册新连接函数，format 2 仍被拒绝。
- 迁移失败在 format 更新边界用 SQLite trigger 注入；检查旧格式、marker、catalog 建表和正文全部回滚，移除故障后同目录迁移成功。覆盖的是事务失败与重试，不是 SIGKILL 或断电恢复。
- 独立历史：删除最后终端仍按 catalog UUID 查正文，保留旧 generation 接口；重新绑定同原生对话复用 UUID；项目删除只解除归属。
- 跨连接元数据：一个连接改名后，另一连接持旧 revision 更新得到 409 conflict；后续消息不覆盖用户标题；归档/取消归档不丢正文。
- 列表与正文：字面 `%_` 不当通配符、分页无重叠/丢行、预览有界、完整 detail 保留；超出预览截断位置的正文尾部标记能经 q 查到，覆盖反方提出的反例。
- 备份：WAL 中已提交数据纳入备份，源/副本仍是旧 schema，没有因备份引入 catalog 迁移；目标已存在时失败且原备份字节不变；无遗留私有 partial/WAL/SHM 文件。
- `backend/tests/conversations.test.ts`：5 个用例。真实临时 HTTP server + fake PTY，验证路由接线、终端删除后离线 list/detail/messages、URL 编码 message ID、metadata conflict/current、过滤、全文尾部 q、有界预览/完整 detail、400/404/405/413/503 与错误信息遮蔽。只读访问的 PTY spawn 计数为零。
- `ai-history-store.test.ts`：保留原正文/分页/修订断言，将旧“最后引用删除后正文清空”改为“移除 live binding，保留 generations 与独立正文”，并保留外层删除事务失败的全表回滚验证。
- `ai-commands.test.ts`：删除终端保留 command 及 accepted receipt；新测试注入 session 删除失败，证实父事务回滚时 nested command 的 queued/writing 状态回到原值。成功删除后 queued→cancelled，writing→uncertain，accepted 不变。

## 独立测试发现并验证修复的问题

1. `conversation_sources` 9 列却使用 10 个 INSERT 占位符：类型检查不能发现，首轮测试导致绑定/迁移失败；store Agent 改为显式列与正确占位符，后续全量通过。
2. 备份清理只删除临时主文件，留下 WAL/SHM 副文件：独立备份断言实测失败；协调者修正临时数据库 journal 模式与清理，最终备份用例通过。
3. 新 `ConversationError` 的 TypeScript parameter property 在裸 Node strip-only 导入时失败：完整 store 回归抓到；实现者改普通字段声明，保留原导入测试，最终 52/52。
4. 测试自身最初把不存在 session 的返回值写为 undefined，现有契约实际为 null；按既有契约修正断言，没有修改业务语义来迎合测试。

## 复现命令

仓库根目录执行；用例全部使用临时数据目录与合成内容，不读取日常对话。

```sh
npm test --workspace @roost/workspace-store
npm test --workspace backend
node --import tsx --experimental-test-module-mocks --test packages/workspace-store/tests/conversations.test.ts backend/tests/conversations.test.ts
npm run typecheck --workspace @roost/workspace-store
npm run typecheck --workspace backend
node scripts/check-boundaries.mjs
```

## 交付边界

G1 独立历史库的本轮自动化验收通过。G2/G3 不在本批：未验证 Agent 发信、run/owner 接管、投递 uncertain 恢复、changes lineage、真实 CLI TUI/GUI 同步；未执行模型请求、日常 daemon 重启或生产数据库迁移，也没有浏览器视觉验收或前端 build 结论。

本轮跨连接 revision 用例验证的是“读到同一版本后的相继提交冲突”；没有据此宣称完成多进程同时提交压力测试。旧 writer 测试使用保留连接与旧 SQL，不是完整旧 daemon 进程的升级演练。G1 发布前的备份/停止旧 writer/迁移操作仍须由协调者按交接文档执行并另留运行证据。
