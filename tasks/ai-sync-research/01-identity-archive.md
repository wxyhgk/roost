# 会话身份安全换绑与 generation 归档调研

调研日期：2026-09-09。只读业务源码；未运行真实 CLI、未重启服务。本文是方案，除“现状”外不是已经实现的能力。

## 建议与用户收益

先做逐条历史与 checkpoint 原子持久化，再做归档与有正文时的自动跟随。用户在同一终端 `/new` 或恢复旧会话后，右侧跟随当前 CLI；旧对话仍可查询，不会被新内容覆盖。无法证明来源时保留 `needs_rebind`，返回明确候选和原因，不能依据最后出现的字符串猜身份。

一个网页终端对应多个 generation；generation 是一次来源绑定/采集区间，并不等同于 CLI 的永久 conversation ID。A→B→A 应产生三代绑定，但可引用同一 canonical conversation 历史；正文以适配器确认的 conversation identity 和原生 message ID 去重。conversation identity 的作用域必须含 CLI/来源，不能仅用一个裸 nativeSessionId。具体表结构与 02 历史方案统一。归档代表“此采集代已结束”，不代表用户把某个 AI 会话标记为不重要。

## 已验证的当前实现

主仓 HEAD `dde67009d412b60c18f3d8c58d57fbdf645939a1`，相关文件含未提交实现，以下行号指本次工作区快照。

- `backend/src/ai-agent-source.ts:55-65,81-96`：仅无正文时自动 `adopt`；有正文则 offline/needs_rebind。`sourceSeq - 1` 是新来源补收起点。
- `packages/ai-session-bridge/src/index.ts:84-96`：rebind 校验 generation/revision，创建空记录直接覆盖旧记录，并清除订阅；没有归档。`:24-25,128-130`：目前仅保留 4096 条 / 8 MiB 缓存，所以第一阶段归档不能宣称完整历史。
- `packages/workspace-store/src/ai-sessions.ts:5-16`：每 webSessionId 一个 JSON 行；native 唯一索引作用于全部当前绑定；save 使用 revision CAS。需要新增事务方法，不能先 archive() 再 save() 两次独立写。
- `backend/src/server.ts:151-184`：人工 rebind 会检查当前 PTY/CLI，并扫描来源日志。但没有拒绝 `page.hasGap`，也没有固定扫描 high-water；不能原样升级为可靠的自动换绑判据。
- `backend/src/server.ts:66-70`：删网页终端同时删除绑定。该操作目前未跨两项写入建立事务；新增归档清理应纳入同一 SQLite 事务。终端被主动删除后的资料保留策略需明确，不能暗改。
- `backend/src/ai-session-stream.ts` 当前 monitor 捕获连接初始 generation；仅推一个新 generation 快照不足以原地切换。首轮沿用关闭旧流、客户端重连契约。

## 第三方设计能借鉴什么

本地 Happier 快照 `d06e287b42e7b73a48159c21731d33d95e966801`：

- `research/third-party/happier/apps/server/prisma/schema.prisma:288-300,359-368,645-674`：Session 单独持有 archive/publisherGeneration，SessionMessage 独立行，localId 去重、seq 索引、rowRevision。值得借鉴“身份、消息、发布者代数分离”；不要复制云端账号、加密与多活复杂度。
- `research/third-party/happier/apps/server/sources/app/presence/sessionPublisherPresence.ts:128-166`：注册发布者在事务内读旧 generation、CAS 加一；旧发布者不能因迟到重新取得新权限。我们可将同一思路用于拒绝旧 PTY/旧异步读取结果，但我们的 generation 是绑定代，语义不能直接等同 publisherGeneration。
- `research/third-party/happier/apps/server/sources/app/api/routes/session/registerSessionArchiveRoutes.ts:34-105`：事务内归档，active 拒绝，提交后发通知。我们借鉴提交后发布，不照搬“运行中不能归档”条件——我们的换绑操作本来就需要原子结束旧代并建立新代。

本地 Warp 快照 `1f0cf55afb29c71d94f2980b384aa11cb3cdb85a`：

- `research/third-party/warp/app/src/ai/blocklist/history_model.rs:251-278`：terminal surface→多个 conversation，conversation 实体与 active 指针分开；清空/关闭表面不是直接销毁全部 conversation。
- 同文件 `:1215-1243,1279-1300`：恢复 conversation 列表，设置 active 前验证归属；转移时通知原 surface 丢弃旧渲染。可借鉴“历史保留+active 指针+显式边界”，不需要照搬 UI 模型。
- `research/third-party/warp/app/src/terminal/cli_agent_sessions/mod.rs:198-207`：CLI OSC session_id 只是覆盖 context 字段。这是状态识别设计，**不是**完整对话身份归档方案，不能把 Warp 原生 conversation 历史与外部 CLI OSC 混为一谈。

以上为源码事实；没有运行这些第三方测试，未验证其线上行为。无需网络补证，本地已提供具体实现。

## 最小数据模型（建议）

保留现有 `ai_session_records` 为当前绑定，新增 `ai_session_generations`：

| 字段 | 用途 |
|---|---|
| generation TEXT PRIMARY KEY | 一代不可变标识 |
| web_session_id TEXT NULL | 来源网页终端；不设置级联删除外键 |
| ordinal INTEGER | 同终端按事务内递增序号排序，不按时间猜先后 |
| binding_json TEXT | cliId/nativeSessionId/terminalInstanceId/路径等身份快照 |
| opened_at / closed_at | 当前代 closed_at 为空，结束代不可继续采集 |
| end_reason | native_changed / terminal_restarted / detached / session_deleted |
| previous_generation TEXT NULL | A→B 的谱系，不等于 conversation 分支 |
| coverage_json TEXT | droppedThrough、sourceHasGap、skipped、已知范围与完整性 |
| conversation_id TEXT | 指向 canonical 正文；不复制多份 8 MiB JSON |

索引 `(web_session_id, ordinal DESC)`；generation 全局唯一。当前 binding 保留既有 `(cliId,nativeSessionId)` 唯一限制，归档不占该限制，避免归档 A 后无法 resume A。迁移阶段旧的 offline 当前绑定仍占用身份，应返回冲突及占用终端，不悄悄抢占；显式“接管”属于后续功能。

正文由历史方案的逐条消息表承载，以 conversation identity 去重，用 generation 记录引用与观测边界；WS seq 与历史 seq 分离。先将已有 JSON 留存消息幂等导入历史库，再迁移 checkpoint；**没有自动恢复已经被淘汰的消息**；不得从仍会变化的 transcriptPath 冒充永久归档。工具详情若仅有原文件引用，归档后仍可能失效，应明确 `detailUnavailable`；持久正文方案负责保存必要正文。

## 原子换绑与来源自证（建议）

1. 后端取得可信候选 `{terminalInstanceId,cliId,nativeSessionId,boundarySeq,highWater,sourceEpoch}`。daemon 增加有界来源快照契约：固定 highWater，分页至此；覆盖需要判定的区间且无 gap。sourceEpoch 是该 PTY 来源身份变化的单调代数，不能用文件 mtime 代替。
2. 普通 replay 接受非当前身份时，仅在同一真实 PTY、CLI 匹配、连续有序来源明确进入另一 nativeId 时推进；若要证明“当前最新身份”，提交前必须重验 epoch/highWater。若 daemon 尚不能提供该能力，就维持保守人工/needs_rebind，不能把 HTTP 多页扫描描述成严格自证。
3. 捕获当前 generation/revision。异步读取完成后再次确认 PTY 与候选证据；迟到旧数据必须丢弃。来自旧 PTY 的 nativeId 或没有 session_id 的孤立事件不能发起换绑。
4. SQLite 单事务：验证 CAS/当前绑定；提交旧代已采集消息/checkpoint 和 coverage；结束旧代；插入新代元信息；替换 active 记录、来源 checkpoint 设 boundarySeq-1；候选/operationId 标记已消费。任何一步失败全部回滚，内存未更新，WS 不发成功。
5. 提交后更新内存并关闭旧 WS，重连返回新快照；崩溃发生在提交后通知前也可通过重连发现新代。新代异步采集携带 generation，旧任务不得写入新代。

注意 SQLite 事务无法与独立 daemon 原子提交：epoch 重验只是减少竞态。要严格杜绝“刚校验后 CLI 又变了”需 daemon 串行协调切换/确认；首轮合理承诺是按有序边界连续跟随，可能短暂显示中间代但绝不跨代混正文。文档/测试不要宣称跨进程线性一致。

现 revision 会随每条消息增长，因此 UI 打开确认后可自然过期。首轮继续 409 后刷新重试，后续可拆 bindingRevision 与 ingestRevision，不能简单移除 CAS。`operationId` 或 candidateId 使断网重试可返回既有结果，不重复创建空代。

## API 与前端契约（建议）

- 现有 `GET /api/ai-sessions/:id` 与 rebind 保持兼容，新增 `pendingIdentity`（candidateId、证据状态、目标、reason），不让前端自己扫描文件推断身份。
- `GET /api/ai-sessions/:id/generations?beforeOrdinal=&limit=`：终端历史元信息。
- `GET /api/ai-generations/:generation`：按代查询归档详情；消息分页接口与历史方案统一。
- 独立全局历史入口仅在产品明确支持“删除终端仍保留历史”时增加，首轮不暗改删除语义。
- 人工 rebind 可新增 `{candidateId,expectedGeneration,expectedRevision,operationId}`，服务端重新验证候选，不把客户端提供 nativeId 当证据。旧请求仍走同一证据检查。
- `DELETE /api/ai-generations/:generation`：显式永久删除本应用副本；当前活跃代 409；不删除 agent 拥有的原始文件。
- 稳定错误码建议：`identity_unconfirmed`、`source_gap`、`binding_changed`、`native_session_in_use`、`generation_active`。保留统一 `{error:{code,message}}`。

## 生命周期、迁移与交付顺序

关闭浏览器/网关重启：不归档，PTY 仍可活着。CLI stop：仅一轮结束，**不**等于 generation 结束。PTY 重建：即使恢复相同 nativeId 也新开绑定代。删终端：首轮保持现有删除本应用会话资料语义，在同一事务删 current、generation 关系并清理无人引用正文；保留其他终端/代共享引用的 conversation，绝不删 CLI 原文件。若希望删终端仍保留历史，必须作为显式 keepHistory 契约另行确定。

1. schema v2 加表，在事务中为旧 active JSON 按原 generation 回填元信息；中断后可幂等重跑。不能恢复升级前已覆盖的 generation。新逻辑启用后旧 gateway 不应并行写；降级至旧 writer 会绕过归档，所以需要 schema capability/version 拦截，而非声称可无条件回滚。
2. 先按 02 落逐条消息+checkpoint 事务，迁移留存 JSON；再落 atomic archive+manual rebind、归档查询与删除测试。旧 UI 不受影响，仍重连加载新代。
3. 完善 daemon 固定来源边界，复用统一判据替换人工扫描；再开启有正文自动跟随。
4. 补齐同 conversation 跨代恢复和引用清理，避免重复正文；保持 generation 与 coverage 表达。

## 验收标准

- A 有正文→B：A 可查、B 独立，A→B→A 三代不误合并；断线重试只建一次。
- unknown 身份、旧 PTY 事件、来源 gap、候选过期、已有绑定占用都不自动抢占。
- 任一步注入 SQLite 故障：active/档案/checkpoint 全回滚，旧连接不收到成功切换。
- 同时自动与人工换绑只成功一个；旧 transcript 读取在切换后完成也不能入新代。
- 提交后/通知前杀死隔离 gateway，重启能查询两代且恢复新 active。
- WS 旧连接关闭，新连接 snapshot 正确；不保留捕获旧 generation 的 monitor。
- 删除终端时 current/代/独占正文原子清理，共享正文不误删；CLI 原文件保留；运行中 generation 单独删除返回 409。
- 缓存曾淘汰/文件不支持/详情失效诚实报告范围，不宣称完整。
- 旧库迁移、重复启动、A→B→A 去重与限制、rollback writer 拦截都用临时 SQLite 验证；真实 CLI 在隔离终端追加验证，不操作日常 daemon。
