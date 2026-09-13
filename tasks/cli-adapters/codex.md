# Codex 同 TUI 同步适配（2026-09-09）

## 结论与本轮交付

本机 Codex CLI 是 **0.153.4**。它已有原生 `codex queue --thread UUID --message TEXT`，协议对应 `thread/queue/add`。这比把文字贴入 TUI 更适合保留用户草稿；但原生队列会在 agent 空闲时自行消费，不保证等用户清空草稿才开始下一轮。

已新增独立、可测试的 `packages/terminal-daemon/src/codex-control.ts`。生产调用入口**暂不自动启用**：当前普通 Codex 终端仍没有可以证明“该 PTY 正在使用这个 socket 上这个 thread”的启动绑定。仅有 rollout 路径、相同 cwd、最近活跃进程或一个有效的 thread ID 不足以获得发送能力。

现有 `packages/ai-transcript/src/codex.ts` 继续提供明确 rollout 路径 + session_meta 身份校验的增量只读同步。它不是自动身份发现器。

## 原生 transport 契约

```ts
const control = createCodexControl({socketPath, threadId, timeoutMs: 5000});
const identity = await control.inspect();
// { threadId, transcriptPath: string | null, status: 'idle' | 'active' }
const receipt = await control.enqueue(requestId, text);
// { status:'native_queued', threadId, requestId, queuedSubmissionId }
control.close();
```

- `socketPath` 必须是明确绝对路径，`threadId` 必须是 UUID。无默认 socket、无进程扫描、无自动重连。
- Unix socket 采用 **WebSocket HTTP Upgrade**，不是 JSONL；JSONL 仅适用于 stdio。本机服务器拒绝默认压缩扩展，因此客户端显式关闭 permessage-deflate；帧上限 1 MiB，超时最多 30 秒。[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)
- 连接后 `initialize` + `initialized`，每次发送先 `thread/read` 且 `includeTurns:false`，仅允许同 ID、状态为 idle/active 的已加载线程。不会调用 thread/start、thread/resume、turn/start、turn/steer，也不会写 PTY 或响应审批请求。
- 原生发送为 `thread/queue/add {threadId,clientUserMessageId:requestId,input:[{type:'text',text,text_elements:[]}]}`。只允许 16 KiB 以内非空纯文本，拒绝控制字符、孤立代理字符及斜杠命令。
- 返回 `native_queued` 只证明原生队列已接管文本，**不是模型已接收、还在排队或已完成**。真实探针里 idle 线程的消息刚入队就被消费，紧接着 queue/list 已为空。
- 同一请求的持久幂等和排队上限仍由公共 command ledger 负责；transport 不假定服务端 requestId 自动去重，不自动重试。
- `CodexControlError.uncertain=true` 表示发送边界之后丢失响应、超时或回执不匹配。调用方必须保留正文并停止自动重发。显式原生 RPC 错误只返回稳定本地 code，原始 server 文本不传给页面。
- `codexAcceptedUserItem(notification,{threadId,requestId,text})` 校验 item/started 或 item/completed 的原生 userMessage：必须 threadId、clientId、文本完全一致且有 native item ID。队列回执不能冒充该证据。当前 transport 仅为队列生产者，没有建立历史/通知订阅；该校验器是后续订阅接线的契约，未声称已完成 acceptance 闭环。

## 下一步接线边界

1. 启动层保存受控 `codex --remote unix://PATH` endpoint，并通过受控线程选择/恢复获取准确 threadId，再绑定 terminalInstanceId + generation。旧的任意启动方式继续只读，不能猜测。
2. command owner 每次写入前检查终端实例、generation、原生 thread 和 endpoint 的绑定仍有效。真正发送后仅 native_queued，等待原生 user item + clientId 转 accepted。
3. 为同一 endpoint/thread 建立可靠订阅或分页读取，重连后用原生 clientId 找接收证据；未知接收结果不能重发。只有 native queue 删除得到确定回执才可取消，不能把网页 pending 和 native pending 混用。
4. 明确产品行为：原生队列不会覆盖 TUI 输入框，但“原生空闲即可执行”不等于 Claude 当前方案的“草稿清空后执行”。若要求 TUI 草稿优先，需要额外可靠输入状态来源，不能凭 queue API 宣称已做到。

这四项尚未接入，因此前端此轮不能将 Codex 标记为已支持同 TUI 双向发送。

## Happier 借鉴

检查了 `research/third-party/happier/apps/cli/src/backends/codex/runCodex.ts` 和 `localControl/requestSwitchToLocal.ts`：Happier 显式管理 local/remote 模式，切换回 local 前处理 pending queue；local→remote 无法恢复同一身份时拒绝创建新远端 session，以免分叉。可借鉴的是控制归属与身份失败时停止，不是复制一个独立 app-server 然后声称已经订阅原 TUI。

新版 Codex 的同 endpoint 原生队列给出了更直接的接线方向，但必须先解决本项目启动身份绑定。

## 验证

- 本机 `codex --version`、`codex queue --help`、`codex app-server --help`：确认 0.153.4 命令和 remote/Unix 支持。
- 本机 `codex app-server generate-ts --experimental --out /tmp/diy-codex-protocol`：核对 ThreadQueueAddParams/Response、UserInput、ThreadReadParams、ThreadItem。生成内容不进入用户数据目录，也不读取历史正文。
- `node --import tsx --test packages/terminal-daemon/tests/codex-control.test.ts`：6 项 fixture，默认跳过 1 项原生测试。覆盖精确 thread、未加载拒绝、断线 uncertain、不重试、错误回执、审批请求不响应及 user item 关联。
- `ROOST_VERIFY_CODEX_CONTROL=1 node --import tsx --test packages/terminal-daemon/tests/codex-control.test.ts`：**7 项通过**。原生测试用独立临时 CODEX_HOME、本机 0.153.4 app-server + Unix WebSocket、独立合成线程，并把模型地址指向 127.0.0.1:1。确认 metadata read 和真实原生 queue 回执；没有使用个人凭据、没有真实模型请求，没有验证实际 TUI 的草稿视觉行为。
- `npm run typecheck --workspace @roost/terminal-daemon`：通过。
- 未重启日常 daemon，未修改前端、用户配置或现有对话。
