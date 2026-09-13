# 对话数据库与 Agent 通讯

本目录集中维护独立对话数据库、Agent 按 ID 通讯及 TUI/GUI 同步的调研、设计和后续实施记录。

## 文档导航

1. [产品调研与独立对话数据库方案](01-product-research.md)：ChatGPT / Claude / Codex 公开行为、现有 SQLite 差距、对话目录与来源、历史保留和迁移验收。
2. [Agent 通讯数据库设计](02-agent-messaging-design.md)：稳定通讯地址、运行归属、信封与收件箱、投递回执、断线补收，以及 A/B/C 通讯闭环。
3. [多 Agent 分工与验收关卡](03-team-and-gates.md)：数据库、投递、API 实现分工，独立测试与反方审查职责，以及阶段通过条件。
4. [独立测试计划](04-test-plan.md)：分阶段验收、故障注入、隔离环境与真实 CLI 证据要求。
5. [独立反方审查](05-skeptic-review.md)：R1—R8 设计风险、反例与放行条件。
6. [G1 实施与升级约定](06-g1-implementation.md)：本批范围、旧写入者保护、备份工具及实际验收结果。
7. [G1 前端接口契约](07-frontend-contract.md)：独立目录与历史读取的请求、响应和错误处理。
8. [G2 实施与 Agent 使用](08-g2-implementation.md)：持久信箱、运行归属、原生投递、命令行与恢复边界。
9. [G2 前端接口契约](09-g2-frontend-contract.md)：发信、状态、一致快照与 HTTP/WS 补收。
10. [G3 真实 CLI 实施记录](10-g3-implementation.md)：隔离原生通讯、任务授权边界与实际测试限制。
11. [G3 前端联调清单](11-g3-frontend-handoff.md)：当前前端缺口、身份关联、消息去重与同步验收。
12. [Claude 协作入口核查](12-cli-cooperation-claude.md)：原生跨会话消息、socket、MCP 与 Channels 的能力和回执边界。
13. [Happier 协作源码研究](13-happier-cooperation.md)：会话工具、同 TUI 输入仲裁和独立执行器的区别。
14. [MCP 通讯工具实施](14-mcp-tools-implementation.md)：独立包、标准工具、复用 IPC 与本批验证。
15. [真实 CLI 加载 MCP 与通讯验证](15-mcp-live-implementation.md)：隔离 Claude、原生 MCP 工具调用与双向接收证据。
16. [MCP 修复后闭环与故障验收](16-mcp-postfix-validation.md)：真实往返、网关重建与草稿保护的分项证据。
17. [MCP 前端联调补充](17-mcp-frontend-handoff.md)：现有接口、投递状态、重新取快照和原生正文关联。
18. [同终端切换 CLI 修复](18-cli-switch-fix.md)：OpenCode→omp 换绑、保留旧历史与过滤迟到事件。
19. [长期对话管理](19-conversation-management.md)：独立选择偏好、终端历史关联、运行轨迹与 daemon 核验的位置接口；后端已实现，全项目 verify 通过，前端待接入。
20. [登录、文件边界、跟随与活动排序](20-access-follow-activity.md)：认证与部署条件、文件 root 归口、当前对话核验和 activity 分页；完整 verify 已通过，未部署日常服务，前端登录与公网 TLS 待验收。
21. [第一条用户消息预览](21-first-user-preview.md)：列表新增 firstUserMessagePreview，用第一句用户文本区分同名对话，不替换标题。
21. 验证记录：G1 [测试](verification/g1-tests.md) / [反方](verification/g1-skeptic.md)，G2 [测试](verification/g2-tests.md) / [反方](verification/g2-skeptic.md)，G3 [测试](verification/g3-tests.md) / [反方](verification/g3-skeptic.md)，MCP [测试计划](verification/g3-cooperation-test-plan.md) / [实际测试](verification/g3-cooperation-tests.md) / [反方](verification/g3-cooperation-skeptic.md)。

## 当前进度

G1 与 G2 已完成本批后端实现和隔离自动化验收，未部署或重启日常服务。

- G1：独立对话目录、单本地来源映射、终端删除后历史与回执保留、HTTP 读取/编辑、旧写入者保护及一致性备份工具。
- G2：运行记录与 owner epoch、持久收发件箱、跨 run 幂等、单 writer 投递与不确定状态保护、Agent IPC/命令行、原子快照与持久变更补收。

本批由存储、运行/投递、changes、API、独立测试、独立反方和主 Agent 协作完成。反方发现的旧 owner 写入及发送者切换两处阻塞缺陷均已修复、独立复测并纳入永久回归。最终 store 74 通过、backend 165 通过/5 跳过、daemon 46 通过/2 跳过；三包类型与边界检查通过。新增永久回归 40 项，包含实际隔离 PTY/socket 的 Agent 脚本接线。真实进程与模拟边界见 G2 验证记录。

以上为 G1/G2 的历史验收数量。本轮 G3 新增真实测试和执行范围反例，最终数量及结论独立记录，不能将默认跳过记为真实验证。

G3 已完成本轮真实 Claude Code 2.1.266 的隔离尝试，**关卡未放行**。第七次实际完成 A→B→A 和 HTTP/WS 断言，但工具审计整测失败；第八次 B 拒绝来信任务，第九次连直接用户协作任务也拒绝，未发 A seed。平台投递 `accepted` 与模型愿意执行是两个事实，不能声称自动应答已稳定可用。最终测试修正另有无模型回归，未再调用模型。详细证据见 G3 报告。

G3 本批默认 backend 全套 167 通过、6 跳过、0 失败，类型和边界检查通过；新增两条默认回归、一条 opt-in 真实测试，并保留 12 份脱敏证据。默认测试通过不覆盖真实模型拒绝或前端视觉验收。

日常原生发送开关未因此开启，前端也未在本批修改。后续按以下顺序推进：

1. 核验适用的 CLI 协作入口与任务执行前提，再有界复验 G3；已有一次两跳传输证据不替代稳定协作或完整关卡。
2. 前端按 G1/G2 契约接独立对话、收发件箱与 changes，同步验证 TUI/GUI、草稿保护和刷新补收。
3. 逐个扩展其他 CLI，每种重复真实接收与回执验收。

固定单本地来源的限制仍在；全链路多来源身份、自动恢复 CLI 和 uncertain 的人工处理界面需另行实施。实施记录、测试报告与前端交接继续放在本目录。

G3 后续已完成 Claude/Happier 并行调研，以及 `@roost/agent-messaging` MCP 工具包的实施与无模型验收。它改善 CLI 的工具发现与发信调用，复用现有 owner/ledger，不替换投递通道。新包 19 通过、daemon 完整串行测试 47 通过/2 跳过、backend 167 通过/6 跳过，三包类型和边界检查通过。反方发现的取消计数泄漏及关闭假死均已修复并独立复测；MCP 工具验收通过不改变 G3 真实自动协作未放行的状态。

修复前 [真实 MCP 验证](15-mcp-live-implementation.md) 完成两次受控尝试：三端 MCP 加载、A→B 原生接收及 B 原生回信工具链成立；B→A 被 Claude 建议文字触发的 `terminal_draft` 阻塞。受控启动关闭建议功能，仍保留真实草稿保护。该轮 [测试报告](verification/g3-mcp-live-tests.md) 与 [反方报告](verification/g3-mcp-live-skeptic.md) 保留原始失败结论。

最新 [修复后验收](16-mcp-postfix-validation.md) 第一次真实尝试已通过 Claude Code 2.1.266 / claude-sonnet-5 的 A→B→A：两跳原生回执、最终回答所属消息链、HTTP 保存和 WebSocket 补收全部通过，C 无输入且资源清理完成。这是限定配置的一次后端真实闭环通过；完整 G3 的浏览器视觉和全部故障场景仍按分项报告验收，不能统称全部完成。

本轮后端验收已收尾：新增两项实际 HTTP/WS/SQLite 网关重建测试通过，CLI 状态与回执明确模拟；最终 backend 171 通过/7 跳过，daemon 50 通过/2 跳过。独立测试与反方限定放行本批后端范围，前端可按 [最新补充](17-mcp-frontend-handoff.md) 开始浏览器联调。
