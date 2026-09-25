# Agent messaging tools

终端里的 agent 互相收发消息。这个包是**客户端**：把一次调用翻译成 daemon owner socket 上的
一次 IPC，复用 daemon 的持久信箱与身份核验，不创建模型进程、不持有 PTY、不直接打开 SQLite。

## 怎么用

本应用创建的每个终端都带着四个环境变量（`ROOST_AGENT_SOCKET`、`ROOST_AGENT_TERMINAL`、
`ROOST_AGENT_INSTANCE`、`ROOST_AGENT_TOKEN`），以及一个指向命令行入口的 `ROOST_AGENT_MESSAGE_CLI`。
凭证由 daemon 核验，不能通过 HTTP 自报身份；命令行不打印凭证。独立启动的普通终端没有这些变量，
调用会明确报错。

```sh
node "$ROOST_AGENT_MESSAGE_CLI" context
node "$ROOST_AGENT_MESSAGE_CLI" peers --from CID --run RUNID
node "$ROOST_AGENT_MESSAGE_CLI" send  --from CID --run RUNID --to RECIPIENT --request-id KEY --text TEXT
node "$ROOST_AGENT_MESSAGE_CLI" inbox --from CID --run RUNID
```

**这里曾经还有一层 MCP stdio 服务器，删掉了。** 它要求给每个 CLI 按各自的格式写一份配置、
显式转发那四个变量，还拖着 `@modelcontextprotocol/sdk` 和 `zod` 两个依赖——而它从来没有被装到
任何日常 CLI 上，README 里当时就写着「本包不自动安装」。两条通道的发现性问题其实是同一个：
**没有任何东西告诉模型这些工具存在**。既然两边都得靠一句提示来解决，就留下不挑 CLI、
不需要配置文件、任何能跑 shell 的 agent 都能用的那一条。

要找回那一层：`git log -- packages/agent-messaging/src/server.mjs`。

## 动词

| 动词 | 参数 | 用途 |
| --- | --- | --- |
| `context` | 无 | 读取当前可信 conversationId/runId |
| `peers` | `--from` `--run` | 列出此刻收得到信的其他对话，给出 `send` 要的 recipientId |
| `send` | `--from` `--run` `--to` `--request-id` `--text`；可选 `--reply-to` | 保存一封发往明确对话的信 |
| `inbox` | `--from` `--run`；可选 `--cursor` `--limit` | 分页查询自己的收件箱 |
| `outbox` | `--from` `--run`；可选 `--cursor` `--limit` | 分页查询自己的发件箱与投递状态 |

`--from` / `--run` 就是那两个身份钉子（`expectedConversationId` / `expectedRunId`）。

先跑 `context`，再把返回的两个 ID 显式传给其他动词。对话或运行已经切换时，旧请求应失败；不能为执行旧任务而自动读取新身份重发。目标使用永久 conversation ID，不用终端标题或文件夹名猜测。

`peers` 是发信链的第一环。在它之前，`context` 只给得出自己的 ID，于是没有人能**先**开口——只能等别人来信再回，而第一封信必须由人在网页上点。它返回的每一项带
`recipientId`、`title`、`cwd`、`cli`，以及 `deliverable` 与 `reason`。

它用的是投递泵（`terminal-daemon/src/peer-delivery.ts` 的 `pump()`）判断收件人的**同一套条件**，所以：不在列表里的对话此刻根本不可寻址；在列表里但 `deliverable` 为 false 的，`reason` 就是泵会写进投递记录的那个字符串（`busy`、`command_pending`、`unsupported_cli` 等），界面上看到的是同一句话。列表里不含调用者自己。

列表是选目标的依据，不是身份来源：仍然按 `recipientId` 发，不要用 `title` 或 `cwd` 去猜。

同一次发信重试保持相同 requestId 与内容。中断命令、超时或连接断开只能停止等待，不能保证已保存的信被撤销；通过信箱核对结果。不会自动重发。

正文最大 15 KiB，分页 limit 为 1–100。参数不接受 token、socket、senderKind 或其他未声明字段——那是把凭据挡在参数外面的那道门。返回中 queued 表示已进入平台信箱；accepted 仍按现有原生接收证据认定，并不表示模型接受任务或已经回信。

## 验收边界

运行 `npm test --workspace @roost/agent-messaging` 和 `npm run typecheck --workspace @roost/agent-messaging`。
真正走完整 IPC（真 owner、真 socket、真 PTY、真跑本包的命令行入口）的是
`packages/terminal-daemon/tests/peer-ipc.test.ts`；投递泵与状态机的逻辑在
`packages/terminal-daemon/tests/peer-delivery.test.ts`。

**本包不自动安装，也不自我介绍。** 终端里有凭证不等于模型知道该调它——要让 agent 主动用，
得在它读得到的地方（项目的 AGENTS.md / CLAUDE.md，或启动时注入的提示）写明这个命令存在。
