# 恢复前确认最新 nativeSessionId

日期：2026-09-12。范围：后端身份采集与终端恢复，不修改前端，不改变 conversationId 设计。

## 使用者要得到的行为

CLI 在同一个终端内切换了原生会话，浏览器刷新后应读取新的身份；终端退出后点击恢复，也应恢复最后确认的那段对话。前端刷新不应重新启动仍然运行的 CLI。

已有 daemon 独立记录身份事件，HTTP 后端订阅并每 250ms 补收，不要求浏览器保持连接。本次修复的是恢复操作与异步补收之间的先后顺序。

## 实现

- 同一终端共享正在执行的补收 Promise。等待同步的调用方会等待它完成，不能把“采集器正忙”当成“已经同步”。
- 恢复前追赶事件并核对末尾，确认当前绑定的来源游标已到 daemon 报告的末尾；读取前后复核 generation、revision、PTY 与 CLI。
- 追赶最多 8 轮，每轮沿用原来的 8 页上限；整个恢复核对最多等待 1500ms。超时后的采集可继续保存事件，但已经返回失败的恢复请求不会在后台启动终端。
- 允许从同一旧 PTY 的连续日志补收退出前的同 CLI 身份切换，旧正文继续归档保留。退出后若出现另一 CLI 的身份、且缺少当前进程证据，则阻止恢复，不猜测恢复对象。
- GET 恢复计划和 POST 实际恢复都执行核对。POST 不信任之前 GET 的结果，并在等待后重新检查终端是否已被另一个请求启动或删除。

## 接口给前端的契约

`GET /api/sessions/:id/resume` 保持 200 + ResumePlan。确认成功返回已有 `{available:true,cliId,cliName,nativeSessionId,command}`；无法确认返回 `{available:false,reason}`。

`POST /api/sessions/:id/reopen` 的 `{resume:true}` 核对失败时返回 409 + `{error:{code,message}}`，不启动 PTY、不将关闭记录改为打开。不带 resume 的普通重开保持原行为。

新增/复用原因：

| reason / code | 建议文案及行为 |
| --- | --- |
| identity_syncing | 正在同步最新对话身份；稍后允许重新查询恢复计划。 |
| identity_unconfirmed | 无法确认要恢复的对话；保留历史，展示诊断，不回退使用缓存 ID。 |
| source_unavailable | 身份日志暂不可用；检查 daemon 连接或版本后重试。 |

原 no_conversation、unsupported_cli、unusable_session_id 继续保留。前端不需要自行传 nativeSessionId；恢复参数仍只有 `{resume:true}`。

## 验证与边界

测试使用真实 HTTP、SQLite/bridge 与模拟 PTY，覆盖退出后 A→B、旧历史保留、后端首次启动追赶、并发等待、GET 后身份再变、多页补收及末尾新增事件、断连/旧协议/日志缺口、超时后不启动、并发普通重开、无法确认的跨 CLI 变化。

本轮新增 8 条恢复回归。后端全量测试 284 项：277 通过、7 跳过、0 失败（`npm test --workspace backend`，日志 `/tmp/native-id-backend.log`）。后端类型检查通过（`npm run typecheck --workspace backend`，日志 `/tmp/native-id-typecheck.log`）。没有执行真实 CLI 恢复或浏览器验收，也没有将这些模拟 PTY 测试报告为现场恢复成功。

这只保证跟随 CLI 已上报并进入 daemon 日志的身份，不会凭空发现 CLI 未报告的变化；有缺口时停止，不承诺跨进程原子观察“绝对最新”。不同 CLI 的真实现场覆盖仍取决于各自适配器。

本次不重启日常 HTTP 服务或 daemon。发布该后端修改后生效；已有 daemon 支持身份日志时无需重启它。
