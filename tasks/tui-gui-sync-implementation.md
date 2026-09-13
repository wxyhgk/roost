# Claude TUI / GUI 同步：后端实现与前端交接

日期：2026-09-09。后端已实现，默认关闭；未修改前端，未重启日常 daemon。

## 用户行为

同一个 Claude 进程、同一个 native session、同一份 transcript。GUI 提交进入 daemon 的持久队列，由实际 PTY 执行。TUI 草稿、忙碌、权限弹窗或无法识别的画面都会阻止自动写入；用户仍可正常操作终端。GUI 不自动批准权限。

每个终端按 FIFO 发送，最多 20 条待发送消息，每条最多 16 KiB UTF-8。首轮只接收普通文本；不接收斜杠命令、终端控制字符或图片。换行统一为 LF。

一次提交使用稳定 requestId。相同 ID 和相同参数重试返回原记录；同 ID 不同参数返回 409。相同正文配不同 ID 是两次独立提交。

## 接口

`GET /api/ai-sessions/:id` 增加 `control`：

```ts
{ supported: boolean, reason: string | null, inputEpoch: number, queue: AiCommand[] }
```

`queue` 是当前活跃记录，包含 uncertain。supported 表示发送能力可用，不表示当前马上可以写入。busy、terminal_draft、dialog 等状态允许排队；身份尚未确认时先等待 binding 完整。

`POST /api/ai-sessions/:id/commands`：

```json
{
  "requestId": "客户端生成并保留的唯一 ID",
  "type": "submit",
  "terminalInstanceId": "当前 binding 的 terminalInstanceId",
  "generation": "当前 binding 的 generation",
  "nativeSessionId": "当前 binding 的 nativeSessionId",
  "text": "请解释这个函数"
}
```

返回 **202 + AiCommand**，包括重复提交。202 仅说明记录已入队，不代表 Claude 已接收。目标身份不一致返回 409 target_changed。

`GET /api/ai-sessions/:id/commands?limit=50&before=123` 返回 `{items,nextCursor}`。按 seq 倒序，limit 为 1..100；下一页使用 nextCursor 作为 before。重连重新查询，不能只依赖 WebSocket。

`POST /api/ai-sessions/:id/commands/:requestId/cancel` 返回 200 + 记录。仅 queued 可以取消；重复取消幂等。已经开始写入返回 409 already_writing。

现有 AI 会话 WebSocket 增加独立事件：

```ts
{ type: 'command-status', command: AiCommand }
```

按 requestId 合并，revision 较大的覆盖旧记录。先订阅再读取列表，合并期间收到的更新；每次重连补读列表及 control.queue。此事件没有独立持久 replay cursor，不计入 transcript 的消息序号。

完整类型在 `packages/terminal-protocol/src/ai-commands.ts`。关键状态：

| 状态 | 前端含义 |
| --- | --- |
| queued | 等待发送，可取消 |
| writing | 进入不可重试的写入边界 |
| awaiting_acceptance | 已调用 PTY 写入，等待原生证据 |
| accepted | 已匹配 hook 和新增 transcript 用户消息 |
| uncertain | 无法确定是否接收，禁止自动重发 |
| cancelled | 尚未写入就被取消，保留正文 |
| failed | 类型预留，本轮没有常规转换入口 |

accepted 表示用户消息被接收，不表示回答完成。真正对话仍使用原有 transcript 流。通过 command.nativeMessageId 与 transcript 的 data.nativeMessageId 对应；不要把 command-status 再插成一条对话，避免重复。

常见等待原因：busy、terminal_draft、dialog、terminal_input、screen_unknown、transcript_unavailable、acceptance_uncertain。能力不可用原因包括 disabled、unsupported_cli、unsupported_version、screen_unavailable、identity_unconfirmed、unsupported_daemon、daemon_unavailable。

错误统一 `{error:{code,message}}`。主要 code：invalid_request（400）、too_large（413）、not_found（404）、request_conflict / already_writing / sending_disabled / control_unavailable / target_changed（409）、queue_full（429）、storage_unavailable（503）。文案由前端按 code 映射。

## 持久化与失效边界

workspace-store 新增独立 ai_commands 表；命令不会冒充原生 transcript。daemon 是唯一执行者，网关只转发。网关重启不重建执行队列，也不会重发已经写入的消息。

写入前保存 writing 状态，在一次有界 PTY write 中发送 bracketed paste 加 Enter。匹配提交后的 UserPromptSubmit hook、输入 epoch 和新增 transcript 用户 UUID 才确认 accepted；同一 native UUID 不能确认两个请求。

10 秒内证据不足转 uncertain，后续同目标消息暂停；迟到的真实证据仍可确认。daemon 重启后 queued 取消，可能已写入的记录变 uncertain；终端实例、generation 或 native session 改变也会使旧目标消息失效。正文保留，不做自动补发，不承诺跨崩溃的 exactly-once 执行。

## 启用、暂停与限制

新 daemon 启动时设置 `ROOST_CLAUDE_GUI_SEND=1` 才配置发送能力。需要新建终端，经现有 zsh Claude launcher 启动，才能取得版本 hook 并从启动时建立屏幕投影。首轮实测版本为 **Claude Code 2.1.266**；其他版本保守禁用。原有 daemon 会返回不支持，不影响普通终端。

```sh
node --import tsx scripts/ai-command-control.mjs status
node --import tsx scripts/ai-command-control.mjs pause
node --import tsx scripts/ai-command-control.mjs resume
```

上述脚本连接应用数据目录对应的 daemon；可用 ROOST_DATA_DIR 指定隔离环境。pause 不重启 daemon、不杀 PTY，只停止新 GUI 写入，保留待发送队列；已经写入的消息继续核对证据。resume 不能开启启动时未配置的能力。暂停状态仅存在于当前 daemon 内存，重启按环境变量恢复。

后端使用 @xterm/headless 6.0.0 识别空白输入框，投影产生的终端查询回复不会写回 PTY。单 daemon 最多 8 个屏幕投影，最大 300 列 × 150 行；解析积压超过 2 MiB 或不认识的画面会停止自动写入。资源限制只影响 GUI 自动发送，普通终端继续可用。识别仍依赖版本及画面特征，升级 Claude 必须先重新验收。

## 验证证据

- 后端及相关包回归：backend 150 通过 / 4 个显式 live 测试跳过；workspace-store 42、terminal-runtime 44、terminal-daemon 15、terminal-protocol 17、ai-session-bridge 7 全通过。随后新增暂停开关，owner + ledger 定向测试 11 项通过。
- 所有 workspace 类型检查通过。
- 隔离 daemon 的真实 Claude 测试 2 项通过：TUI 半截草稿阻止 GUI 写入；清除测试草稿后两条请求顺序执行，实际 Bash 工具结果与回复进入共享 transcript；第一条开始写入后断开并重新连接网关，无重复执行。
- 真实权限弹窗阻止下一条写入；重启隔离 daemon 后未发送消息取消且正文保留。
- 真实测试入口：`ROOST_VERIFY_CLAUDE_SEND=1 node --import tsx --test backend/tests/claude-send-live.test.ts`，会调用真实模型；常规测试默认跳过。

真实验证覆盖后端 API / PTY / transcript，没有宣称前端 GUI 已完成或完成浏览器视觉验收。下一步由前端接输入框、队列及状态，再联合验证双栏体验。
