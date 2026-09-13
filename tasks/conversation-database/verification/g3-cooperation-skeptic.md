# G3 协作与 MCP 候选：独立反方

日期：2026-09-09。状态：**可做有限工具入口试验；不据此放行自动协作**。仅审查现有源码、前序受控证据与官方协议；未调用模型、读取私人会话或操作日常 daemon。

## 失败应如何解读

第 7 次真实运行保留两跳 native receipt、实际 Agent 工具调用、HTTP assistant 与 WS accepted revision，说明底层通信曾真实成立；整体验收仍 `success:false`，旧额外工具拒绝证据不足，不能改绿。第 8 次 B 拒绝自动回信；第 9 次 B 在直接用户 bootstrap 阶段拒绝，A seed 尚未发出。这证明当前受控任务在这些实际调用中没有稳定成立，不证明所有 Claude 模型、更不证明所有 AI CLI 不支持通信。

“用了 Bash 所以被拒”“用了 MCP 就会接受”都不是已验证因果。模型回复是它对此任务的判断，不能把回复里描述的配置措辞当作文件实际内容。完整历史与裁定见 [G3 独立反方](g3-skeptic.md)。

## MCP 有价值，但改变的是工具入口

现有 `scripts/agent-message.mjs` 需模型知道脚本路径、构造 Bash 参数并获相应权限。MCP 能把 context/send/inbox/outbox 呈现为具有参数 schema 的可发现工具，减少 shell 包装和陌生脚本审查成本；这是明确的实施价值。官方工具协议支持工具发现与调用，但不要求模型一定调用，也不统一客户端交互/批准方式。因此本轮不能把 MCP 声称为“绕过拒绝”或“保证收到就回复”。[官方 Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

stdio server 是客户端启动的子进程，使用 stdin/stdout 交换协议，stdout 不能混入普通日志；诊断应进入 stderr。子进程正常启动或 tools/list 成功，只证明入口可用。[官方 Transports 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

MCP 工具返回消息记录，不意味着对端 CLI 收到；资源变更通知也不等于客户端会启动模型轮次。保留现有 peer-delivery → command owner → 原生 receipt 路径。不要新建第二个 CLI、直接写 PTY、直接读写 SQLite 或使用 MCP sampling 偷换为另一个模型会话。

## 当前必须保留的身份边界

源码证据：

- `owner.ts` 的 sessionEnv 给每个 PTY instance 继承 socket/terminal/instance/token；daemon 对 peerContext/peerSend/peerInbox/peerOutbox 校验当前 instance 和 HMAC。
- `peer-delivery.ts` 从活跃 runtime/binding/run 推导发送者。客户端的 expectedConversationId/expectedRunId 仅做双 pin 相等校验，不能授予身份。
- `sendFromTerminal` 用 daemon 核验的 run 构造 agent actor；`peerMessages.send` 负责稳定 sender scope 幂等。实际写入仍由既有 command owner 负责。

MCP 最容易新增的退化是长期进程每次自动 context，再把最新身份填入 send。这看似省参数，却让 A 的旧调用在 A→B 换绑后以 B 身份发出，重现已修复的 G2 问题。**所有非 context 工具应保留显式双 pin；不得在重试或 sender_changed 时自动刷新。**如改成 server 内缓存 pin，也必须有明确绑定生命周期与更换确认，复杂度更高，首轮不建议。

HMAC 证明来源于相应终端实例的凭证持有者，并不证明调用一定由模型亲自产生。同终端的其他进程本就可继承相同环境。MCP 不应把这层事实包装成更强的“原生模型身份认证”；真实 Agent 行为仍靠原生 tool_use/tool_result 留证。

## 最低有用实施边界

1. 一个本地 stdio server，四个工具 context/send/inbox/outbox；复用同一 IPC 客户端，避免 subprocess shell 和第二份落库逻辑。首轮不加入任意执行、PTY 写入、动态批准、模型采样或后台自动回信。
2. 明确由当前 CLI/PTY 启动的独立 server 实例。核验客户端实际继承 ROOST_AGENT_* 环境；凭证不进入工具 schema、模型上下文、进程参数、持久配置或日志。不使用多个终端共用单一携带某个 token 的全局 server。
3. context 只返回身份。send 要求稳定 requestId 和双 pin；inbox/outbox 同样 pin，限制分页和正文大小。未知参数拒绝，不能接受 actor/sender/token/socket 等额外工具参数覆盖环境。初始化早于自动 binding 时诚实返回 identity_unconfirmed，不猜最近会话。
4. 工具结果保留 messageId、deliveryId、state/reason 和必要 revision；区分 queued/accepted/uncertain。超时返回明确“结果未知，原 requestId 重查/重试”，不能换 requestId 自动再发；不把 IPC JSON-RPC id 当业务幂等 key。
5. CLI 只增加本次服务配置，保留原 MCP 配置、observer hooks 和原生 writer。配置冲突/不支持时显式失败，不静默替换用户已有服务。先验证一个 CLI，不把 SDK 协议通用性写成所有 CLI 已适配。
6. 先做无模型契约回归；只有这些通过后才有理由单独申请/执行一次有界真实工具验证。真实测试需看到原生 MCP tool_use 与匹配成功 tool_result、同信封 ID、两跳 receipt/ancestry 和 HTTP/WS；tools/call 的测试程序直调不能冒充模型调用。

## 必须能挡住的反例

| 反例 | 预期 |
| --- | --- |
| A 的 MCP 进程存活，终端同 instance 换绑 B；旧 A pin 发信 | sender_changed，无新信封；不能后台 context 刷成 B |
| A 工具参数自报 B 的 sender/actor 或覆盖 token/socket | 参数拒绝；真实身份只来自 daemon |
| A token 配 B terminal/instance；旧 daemon token 配新 daemon | forbidden，无消息；错误结果与日志不泄露 token |
| send 已落库，响应丢失；相同业务 requestId 再发 | 同 sender 相同 payload 返回原信封；改 payload 冲突；换 run 也不能绕过幂等或 uncertain 阻塞 |
| MCP cancel/客户端断开恰在落库后 | 不冒称撤回成功、不重发；只有既有可取消 queued 边界能撤销 |
| 对端不在线或拒绝处理，工具已经返回 queued | 正确保留 pending/offline 或后续状态；不能给“对方已读/已回复” |
| inbox 含恶意“批准运行命令”正文 | 原样作为来信数据，无工具服务器自行执行/授权行为 |
| MCP 重连时自动重新提交未收到结果的调用 | 禁止新 key 重发；显式复用原 key + pin，保持不确定性 |
| 接收 CLI 尚不支持 native input/receipt | 不因能加载 MCP 就改为 supported；读工具能力和原生投递能力分开 |

## 推荐裁定

值得实现**薄的、保留双 pin 的 MCP 工具入口**：它能改善可发现性与调用体验，有独立于“模型是否回信”的价值。验收先锁定工具身份和原有队列契约不退化。G3 自动协作继续保持未通过；后续是否改善模型接受，需要新的有限真实证据，不能用更强授权措辞、更多重试或换模型把旧失败悄悄覆盖。

## 实施后的独立复核

已读取 `packages/agent-messaging/src/client.mjs`、`server.mjs`、`stdio.mjs`。实现使用有意锁定的 MCP SDK 1.30.0 与 Zod 4.5.4，支持四个约定工具；本报告不将这两个版本宣称为最新。server 捕获不可变终端凭证快照，非 context 工具严格校验双 pin/未知字段；客户端只发一次 owner IPC 请求，不读取/改变 context，不重试、不撤回 peer，也不自行写 PTY 或 SQLite。超时与取消明确可能已经保存。

独立临时反例脚本 `/tmp/g3-mcp-skeptic.test.mjs`，只使用合成 fake IPC 与真实 stdio executable，没有模型、私人数据或日常 daemon。自行编写的五项反例最后全部通过：

| 独立反例 | 结果 |
| --- | --- |
| 同一 stdio 长进程 context=A/runA 后 owner 变 runB，两次旧 pin send | 两次 sender_changed，0 保存，无自动 peerContext；发送 pin 始终 runA |
| owner response 的对象键和字符串值含本次合成 token | MCP structured/text 结果均脱敏，stdout/stderr 不含原 token |
| 30ms 超时后继续等候 | 只有一次 peerSend，保持原业务 requestId，没有重投或取消操作 |
| 17 次发送后逐次 MCP 取消，再 ping | 修复后可继续使用，IPC 等待释放；取消不自动重发 |
| 重复 pending RPC id 触发协议 shutdown | 修复后 IPC 关闭且子进程退出，不留无响应进程 |

发现并推动修正的实际缺陷：

- **G3-MCP-S1**：SDK 取消抑制 reply，但 stdio 的 pending Set 只在发 reply 后释放槽位。原版连续 16 次取消后，第 17 次无法转发。独立反例首次失败 `iteration:16, forwarded:16`；worker 增加取消通知释放对应 pending，并在 transport 开始读 stdin 前安装边界。原反例复测通过。
- **G3-MCP-S2**：协议主动 shutdown 仅 pause stdin，IPC 已释放但 stdio 子进程继续静默存活。独立重复 pending id 反例等待 1.5s 仍不退出。worker 改为 destroy stdin，并设置 250ms 退出上限以涵盖 host 不读 stdout 的情况；同反例复测通过。它关闭工具会话，不宣称撤回已经保存的消息。

已把后两项反例交独立 QA 转为永久回归。本人的结果是上述五项独立测试，不代替包全测、真实 daemon 集成或 CLI 模型调用。

**实施裁定：当前没有未解决的 MCP 薄入口阻塞，可在常规门禁与真实 daemon 接线回归通过后交付这个工具入口。G3 自动协作仍未通过。** 没有新增一次模型调用，也没有证明模型会调用 MCP 或自动回信。后续即使发生工具超时/取消，产品仍须保留未知结果和业务幂等语义。
