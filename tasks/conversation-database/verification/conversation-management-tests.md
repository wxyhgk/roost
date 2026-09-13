# Conversation 长期管理：独立 QA

状态：独立 HTTP 集成专项 4/4 通过，0 skip / 0 fail；使用临时 SQLite、真实 bridge / HTTP 与可控 runtime。不启动真实 AI、不访问日常数据，不将模拟 RPC 当成实际 daemon 认证证明。

入口：[conversation-management.test.ts](../../../backend/tests/conversation-management.test.ts)。执行：

```sh
node --import tsx --experimental-test-module-mocks --test backend/tests/conversation-management.test.ts
```

最终日志 `/tmp/conversation-management-qa-final.log`，耗时约 0.43 秒。主负责人单独运行全量验证，最终大门禁结果由主报告汇总，未重复启动整套或模型。

## 已验证的行为

| 目标 | 具体证据 |
|---|---|
| 对话独立于当前终端 CLI | 同终端 opencode→omp→opencode，即便 native 字符串相同，两种 CLI 分别拥有 catalog UUID；旧对话仍可选，新终端绑定不替代 selectedConversationId |
| 终端关联去重 | 同一对话多次 generation/run 仅返回一条关联；终端删除后两条历史关联仍可查询 |
| 选择状态持久化 | 初始 null / false，follow 仅存 UI 偏好；POST terminal/kill 后选择和历史保留；重新打开 SQLite store 后仍可读取 |
| 历史与运行分开 | `/runs` 所有记录 runtimeVerified=false；旧对话没有 active run 时 `/runtime` 返回 409，仍可查询旧历史 |
| 当前运行验证 | 可控 RPC 返回当前匹配候选才 200；断线/缺方法 503，缺 live/关闭终端/instance 或 CLI 漂移/旧 binding 409；RPC 等待期间 instance 变化也拒绝 |
| 有界运行历史 | 同一对话 1 条 legacy generation + 2 条 run，以 limit=1 取得三页，没有 run/generation 双份；跨 conversation 或 terminal filter cursor 拒绝 400 |
| 稳定输入错误 | 非法 limit、重复/未知 query、空 cursor/terminalId 拒绝 400；未知对话 404；错误偏好值或未知所选对话不部分写入 follow 偏好 |
| 只读路径 | 列表/detail/runs/runtime 查询均不调用 ensureSession 或 writeSession，fake PTY 创建计数不增加 |

## 修正与证据边界

初次专项有两个夹具/集成时序问题：终端删除误用不存在的 DELETE 路径，改用现有 POST `/api/sessions/:id/kill`；首次 runtime 请求发生在接口仍落盘期间返回 503，当前完整接线下通过。不把这些称为已证实业务缺陷。

独立 QA 另构造了 `pid:null, dead:true` 的异常 runtime 数据，最初 HTTP 接受该候选，主负责人增加正整数 PID 的防御性检查后回归通过。真实 `TerminalSession` 类型要求 PID 为 number 且没有 dead 字段，退出 PTY 会从 runtime map 移除；此用例超出当前接口类型，不能据此宣称真实 daemon 已发生这种返回或泄漏写入权限。正常契约内的缺 live、关闭、CLI/instance/binding 漂移分别独立验证。

`/runtime` 的成功只表示这次查询核对到当前运行位置，不是持久写入凭证，也不启动/恢复对话。真正 daemon owner/source 检查由该模块专属测试提供证据，本文件故意让 fake RPC 返回候选以独立验证 HTTP 的二次校验。未验证浏览器选择交互或真实 CLI 续聊。
