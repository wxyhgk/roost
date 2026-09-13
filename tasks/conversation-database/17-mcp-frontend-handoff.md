# MCP 通讯后的前端联调补充

日期：2026-09-09。本文件只交接后端已有接口，不修改前端。实际验收状态以 [修后验证](16-mcp-postfix-validation.md) 和对应独立报告为准；不得用自动化 HTTP/WS 验证代替浏览器双视图验收。

## 接线方式

沿用 [G1](07-frontend-contract.md)、[G2](09-g2-frontend-contract.md) 和 [双视图清单](11-g3-frontend-handoff.md) 的身份及去重约定。MCP 是原生 Agent 的工具入口，前端无需启动 MCP 服务或接触终端凭证。

| 使用者操作 | 前端调用或展示 |
| --- | --- |
| 打开对话 | 使用永久 conversationId 取 `GET /api/conversations/:id/snapshot`，应用历史、run、收发件箱和顶层 cursor。 |
| 发送用户消息 | `POST /api/conversations/:id/inbox`，body 为 `{requestId,text}`；202 只代表已保存并排队。 |
| 查看 Agent 互相通讯 | 按收发件箱和 `GET /api/peer-messages/:id` 展示服务端确定的发送者及 inReplyTo，不让网页自报 Agent 身份。 |
| 实时同步 | 使用快照顶层 cursor 连接 `/api/conversations/:id/stream`；changes 的 peer entityId 是消息 ID，需要回读详情。 |
| 跳回终端 | 按 snapshot.run 的 webSessionId 和 terminalInstanceId 定位；run 为空仍可阅读历史。 |

## 状态如何解释

| 状态/原因 | 对使用者的含义 | 页面行为 |
| --- | --- | --- |
| queued / terminal_draft | 终端输入框还有文字，暂不写入 | 保留排队；可跳回终端查看，不能自动清空草稿。 |
| queued / busy | CLI 正在处理另一轮 | 显示等待，不创建重复请求。 |
| queued / dialog | 终端有需要处理的选择框 | 提供跳回终端的入口，不猜按键批准。 |
| queued / 其他原因 | 当前还不能投递 | 显示保守兜底及原因；不能因 run 存在就显示已送达。 |
| dispatching | 已进入提交流程，仍在等待回执 | 不把它当已接收，也不允许自动重复发送。 |
| accepted | CLI 的原生输入已由精确回执确认 | 可关联原生历史；不等于 Agent 已完成任务。 |
| uncertain | 可能已写入，但尚无足够回执 | 保留现有请求，不能自动换 requestId 重发。 |
| failed / cancelled | 投递失败或已取消 | 显示服务端状态；保留原始内容供查看。 |

只有 queued 可通过 `POST /api/peer-deliveries/:id/cancel` 取消；遇到 409 `already_dispatching` 应回读最新状态。草稿识别仍是保护机制；启动器关闭建议文字的兼容修复不改变上述约定，也不会更新已经运行的 CLI。

## 重连与去重

同一 HTTP 网关内断线，用最后成功应用的 cursor 补收。网关重启会更换 epoch，旧 cursor 返回 `resync_required`：重新获取 snapshot 后继续订阅，不能无限重试旧 cursor。历史消息分页和收发件箱分页 cursor 不能用作 stream cursor。

accepted 信封与原生正文必须按 `targetSourceId + acceptedNativeMessageId` 精确关联。正文来自历史采集，不能在发送 HTTP 成功时额外拼成一条原生 user 消息。显示正文与来源标注即可，避免同一输入出现两次。

用户发送请求因断线没有收到响应时，保留相同 requestId 和原正文重试。同 ID 不同正文返回 `request_conflict`，不得静默覆盖。HTTP 用户发信和原生 MCP Agent 发信来源不同；页面不要把用户输入冒充为 A 发给 B。

## 前端人员验收

1. A/B 的 GUI 与各自 TUI 对应同一原生对话，来信、回信及最终回答各显示一次。
2. 浏览器断线、刷新、HTTP 重启后，按上述游标规则恢复；未提交输入保留。
3. 在终端键入真实草稿后发信，页面显示等待，草稿完整保留。
4. 终端退出后仍能从对话目录读取已保存历史；页面不自动重建 CLI 或宣称能继续生成。

后端真实测试使用已清理的临时对话 ID，前端联调应创建自己的隔离会话。具体 CLI/模型的一次后端往返通过不代表所有 CLI 或任意协作任务都已稳定支持。
