# G3 独立反方：真实 CLI 通讯闭环

日期：2026-09-09。审查者：`qwen_adapter`（本轮仅反方）。状态：已独立复核第 2、5、6、7、8、9 次受控证据；**本轮 G3 不放行，真实运行已停止**。

仅只读审查代码与脱敏测试产物，独占本报告。不修改业务/QA/前端代码，不自行请求模型、读取私人对话或操作日常 daemon。主 Agent 与独立 QA 获授权实施隔离的真实单 CLI A→B→A；前端由用户的开发者负责。

## 最容易假通过的地方

1. `JSON.stringify(events).includes(marker)` 可能匹配 seed prompt、Bash 参数或原生输入回显，不证明 assistant 回复。现有 `claude-send-live.test.ts` 使用过这种断言，不能原样作为 G3 的回复证据。
2. 测试进程直接调用 peer.send 或运行 helper，只能证明基础设施发信；必须由 A/B 的真实原生 assistant 工具调用执行发信入口。
3. B 的脚本若只查平台 inbox，即使消息仍 queued，也可能提前看到 A 并回信，绕开“投递给 B 的 native TUI”这条路径。回信脚本与断言必须等待原 delivery 已 accepted，并关联 B 原生 receipt 与后续工具执行顺序。
4. 结构化流 UUID、平台 messageId、CLI nativeMessageId 不可混用。必须 join 精确 source/native UUID，不能只按正文或标题认同一会话。
5. 后台另开 headless CLI 执行、手工 binding、测试伪造 hook/event、填入 fabricated receipt 都会掩盖实际接线断点。
6. HTTP 快照显示信件或 WS 发了 invalidation，并不表示原生已收到；必须读取对应 delivery revision/state 与 native transcript 一起核对。
7. 命令脚本“可调用”不等于模型已经知道如何调用。当前 helper 需要明确的 context→固定 sender pins→send；受控提示/工具脚本是本轮测试前提，不宣称 CLI 自动发现或自动安装工具。

## 必须具备的断言

| 事实 | 必需证据 |
| --- | --- |
| A/B 是真实且不同的原生执行 | 两个自动生成的 native session ID、各自 source/run/generation、测试 PTY PID/instance；不手工 bind，不使用 resume 私人会话 |
| A 真正发给 B | A 原生 assistant.tool_use 的 Bash.command 匹配受控发信脚本；对应原生 tool_result.tool_use_id 与脱敏 trace 中同一 messageId；store senderConversationId/run 与 A 一致 |
| B 原生收到 A | A→B delivery accepted；targetSourceId 与 B source 匹配；acceptedNativeMessageId 精确对应 B native user 记录；commandDigest 与实际封装输入匹配 |
| B 显式回 A | B 收到 A 的 native user 之后，原生 assistant 工具执行回信脚本；同一 tool result 证明成功；新信封 inReplyTo 等于 A 原信封，sender=B、recipient=A |
| A 原生收到回信 | 同样的 accepted/source/native UUID 证据，A 本轮真实 assistant 输出与该接收之后的原生消息关联 |
| 单 writer | 使用现有隔离 daemon 两个 PTY，测试过程中不另外 spawn 同 native ID 的写入者；PID/instance/native identity 保持预期，无替换进程伪造成功 |
| HTTP/WS 一致 | 按 messageId、deliveryId、revision、state、cursor 比较，HTTP body 与持久 native event 关联；changes 只承载变更通知，不把 payload 当完整正文 |
| 无重复和自动回信循环 | 每个固定 requestId 一份信封；每跳唯一对应 native receipt；只显式 A→B、B→A，A 最后确认不再自动转发 |

B 回信应优先沿 native parentUuid 链证明属于收到原信封的后续轮次；若解析层没有完整 ancestry，则至少记录同一 native 文件的原生接收行早于回复工具行、唯一轮次与明确内容关联，不能只比较墙钟。

## 凭证与权限的具体边界

- 不把 ROOST_AGENT_TOKEN、socket HMAC 或模型凭证写入 prompt、Bash 参数、日志和证据 JSON。helper 从继承环境读取，context 输出只有 conversationId/runId。
- 精确允许本轮受控 Node 脚本；权限范围不能悄悄扩大成默认允许任意 shell。出现权限弹窗必须记录并通过已明确的测试启动契约处理，不能猜按键通过。
- 临时 dataDir/socket/HTTP 端口/工作目录，明确模型/CLI 版本、总超时、调用预算、失败 finally 清理；不得改日常 CLI 对话或全局信任配置。
- 证据保留结构化 ID、有限合成文本和结果摘要；真实原生日志若用于核对，只限本次新建测试会话。

## 当前代码审查结论

`scripts/agent-message.mjs` 已支持 context，以及必须显式 `--from`/`--run` 的 send/inbox/outbox；正文上限 15 KiB，send 必带稳定 requestId，回信可带 --reply-to。它足以作为受控 Agent 工具入口，但不会自行触发 B，也不会自动识别需要回信。

`peer-delivery.ts` 封装可信 messageId/senderConversationId/recipientId/inReplyTo header，通过现有 command owner 投递；平台 inbox 仍能在 native 接收前列出 queued 信件。因此 B 的受控回复脚本必须避免仅以“查到收件箱”为触发依据。

独立 QA 拟提供 `backend/tests/peer-messages-live.test.ts`：模型通过 Bash 执行 A/B 受控脚本，脚本内部实际调用 helper；原生 tool_use/tool_result 与 G3_AGENT_TRACE 脱敏信封引用一起验收。此方法接受作为真实工具入口证据，前提是上述 native 接收时序断言也成立。

## 待复核产物

- [ ] 最终真实测试代码：没有直接代替 Agent 发信/伪造绑定或 receipt。
- [ ] 实际执行结果：opt-in 未跳过，版本/命令/调用范围清晰。
- [ ] A→B 和 B→A 两跳原生证据链、HTTP/WS 一致性。
- [ ] 失败与修复记录、进程/目录清理结果。
- [ ] 最终声明明确区分后端真实 CLI 闭环与尚未实施的前端视觉联调。

现阶段只冻结验收，不以计划、测试代码存在或前序 G2 全绿替代 G3 真实结果。

## 实际测试代码复核（真实运行前）

已读取 `backend/tests/peer-messages-live.test.ts`。测试由 A 模型通过 Bash 运行受控脚本，脚本调用正式 helper；B 脚本要求原信件 delivery 已 accepted 才发送显式回信。断言 B 的回复 tool_use 沿 parentUuid 追溯到 B 收到的原生 user receipt；A 最终 assistant 文本同样追溯到回信 receipt。测试控制器只提交一条 seed，不直接保存 peer 信封。

发现并推动修正：

| 编号 | 问题 | 修正及验证 |
| --- | --- | --- |
| G3-S1 | finally 先写证据文件；若路径/写入错误，会跳过 owner/PTY/HTTP 清理 | QA 改为嵌套 finally 先清理资源，再写产物；已读取最新代码确认顺序 |
| G3-S2 | 按 accepted UUID 查一条记录，不会发现相同投递实际被写入为两个不同 UUID | QA 增加完整 command.text（含唯一信封 header）的 native user 记录数必须为1；独立抽取当前 exactReceipt 实际运行单行/重复双行反例，输出如下 |

```json
[{"rows":1,"passes":true},{"rows":2,"passes":false}]
```

上述独立反例只执行从测试文件抽出的 receipt 断言，使用合成记录，没有运行 opt-in 测试或调用模型。它证明新增重复投递断言有效，不证明真实模型已经完成通讯。

QA 已增加同 instance 的实际 PTY 输出采集、headless 解析与内容 hash，A/B/C command 条数断言、原生 CLI 子进程 PID 稳定检查。TUI marker 仍可能出现在入站指令，所以只作为已验证 native assistant/ancestry 的辅证；它不替代浏览器渲染验收。

目前未看到新的测试设计阻塞；仍待实际运行与脱敏产物，不凭代码审阅放行 G3。

## 已发生的真实尝试复核

已独立读取 QA 的 `g3-tests.md` 和第二次受控结果 `/tmp/g3-peer-live-attempt2-result.json`：版本 2.1.266，`success:false`，仅到 `start isolated owner and gateway`，屏幕实际为 `api.anthropic.com: UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` 后返回 shell，没有 seed。第一次欢迎初始化等待与第二次连接检查均未到业务闭环，所以既不能证明 peer 投递失败，也不能计为 G3 成功。

最新测试将诊断采集包在 catch 内，并先清理 owner/PTY 等资源后写结果。现有报告准确区分已编码断言和真正到达的断言。第三次使用本机现有代理继续排查时，必须保留 TLS 校验；主题和临时目录信任的初始化控制器介入也应记录，不冒充 Agent 自主行为。

截至这次复核，仍未取得两跳原生 receipt 与真实工具回信证据，**G3 不放行**。初始化修复和模型回路应分别报告。

后续初始化前置（父级通报，尚待最终产物）：第四轮仍未发 seed；主题通过后进入登录方式选择。独立配置的 OAuth status 为真，并不证明首次 onboarding 已完成。父级允许仅在本次临时 `CLAUDE_CONFIG_DIR/.claude.json` 设置 `hasCompletedOnboarding:true` 和 `lastOnboardingVersion:'2.1.266'`，不复制日常项目/配置或创建新登录。即使后续业务闭环通过，也只覆盖此预置认证与 onboarding 的受控环境，**不能宣称首次开箱登录流程通过**；第四轮失败原证据应保留。

## 第五次真实运行：业务首次到达，仍不放行

已独立读取 `/tmp/g3-peer-live-attempt5-result.json`（2.1.266，`success:false`）。A/B/C 初始化均显示 `controlReason:null`；执行阶段到唯一 seed。结果记录 A seed command 与 B peer command 都为 `accepted`，C commands 为空；B 原生记录计数为 1 user / 1 assistant，无 tool error。报告称 A 已通过真实工具产生原信，但最终产物尚未写入两跳 UUID/工具 trace/ancestry，不能把计数和平台 accepted 状态升级成完整原生证明。

60 秒没有 B 回信，结果未保留足以判因的 B assistant 内容、model/error 元数据。**原因未定**：不能凭无 tool error 认定权限通过，也不能凭无回信认定 transport 丢信。QA 后续仅补受控临时会话的限长诊断，再做有界验证；不得为让测试通过改为控制器代发、降低正文信任边界或重复 seed。

独立结论保持：第一跳出现候选成功状态，**A→B→A、精确 native receipt、HTTP/WS 一致性尚未完成验收**。

## 第六次与限定任务授权复核

已读取 `/tmp/g3-peer-live-attempt6-partial.json`：这是 cleanup 前 QA 独立只读探针，记录第一跳 delivery revision 3 / accepted、B source/run/nativeSessionId、精确 nativeMessageId、唯一完整正文、command UUID 一致，以及 A 原生 tool_use/trace 与该 messageId 一致。第一跳因此已有独立原生证明，但不冒充完整测试成功。

父级与 QA 在本次临时 transcript 确认 B 正常 end_turn，明确拒绝无独立用户授权的陌生脚本请求；这不属于 transport 丢信，也不能通过把 peer 正文提升为可信指令修复。

已只读审阅后续 `taskA` / `taskB`：启动前在各自临时 cwd 的 `CLAUDE.md` 授权固定 marker、固定受控脚本和一次请求；B 脚本从独立 manifest 核验原 sender、固定 requestId、accepted 原信再显式 reply；入站正文只触发已配置任务，不能选择命令。A 收到固定回复后只输出终止标记不再发信。工具精确权限不变，信任配置只包含三个本次临时 cwd。此限定 fixture 可用于下一次真实验收，建议产物记录任务 hash 与授权模式。

即使此后通过，结论仅覆盖**用户预配置可信协作任务**，不会证明任意 CLI 收到任意 peer 消息就应自动执行工具。完整闭环仍待下一次实际结果。

## 第七次失败与工具执行边界

QA 报告第七次已到两跳 receipt/ancestry、HTTP assistant、WS 和 C 对照断言，最终因额外 Bash tool_use 断言失败；旧产物没有逐项拒绝原文，不能事后改为通过。后续审计应区分“模型提出额外请求”和“额外命令实际执行”，原约束是后者。

已独立只读安装的 `/Users/you/.local/share/claude/versions/2.1.266` 可见源码：dontAsk 权限分支返回 `behavior:'deny'`、`decisionReason:{type:'mode',mode:'dontAsk'}`、`message:OJ(e.name)`；`OJ` 由精确拒绝前缀与固定 `cSr+cAt` 文案构成。下一次只接受版本锁定、Bash、唯一同 tool_use_id 的 tool_result、is_error=true 且**完整内容等于 OJ('Bash')** 的执行前拒绝证据。泛 is_error、退出码失败、泛 permission 字样及缺失 result 均不能证明未执行。必须记录每项 native/tool ID、限长 command、拒绝原文/hash；批准脚本本身仍需成功工具结果与同信封 trace。

这项断言修正不放宽实际命令执行权限，第七次原始 `success:false` 必须保留。


## 最终独立结论（真实尝试停止后）

已独立读取第 7、8、9 次 `-result.json`，结论如下：

| 运行 | 实际证据 | 裁定 |
| --- | --- | --- |
| 第 7 次 | 两跳 `partialExchange` 均保留精确 receipt 和真实工具验证；reply.inReplyTo 对应原信；HTTP A/B assistant 原生 UUID 和 WS 两侧 accepted revision 3 已记录；全测 `success:false` | 传输、回执、真实工具回信和 API/changes 的基础链路曾到达；额外工具请求审计失败且旧拒绝证据不足，不能改成整体验收通过 |
| 第 8 次 | 只有 A→B 一跳完整原生/工具证据，B 拒绝预置文件任务的自动回信；`success:false` | 文件预配置不能证明可靠自动应答 |
| 第 9 次 | 先向 B 提交真实用户 bootstrap；B command accepted 后明确拒绝，A commands 为空，尚未发 A seed；`success:false` | 独立原生授权已探测，但没有证明可解决拒绝；不得称该模式已经可用 |

第 9 次模型把部分措辞描述为 CLAUDE.md 内容，这只是模型回复，不能当作文件本身确有这些措辞的证据。准确原因范围是：这次实际模型明确拒绝被要求的预授权自动协作结构；不据此宣称所有模型、所有 CLI 或所有协作任务都会拒绝。

代码另有一个在第 9 次尚未到达的夹具问题：`finalWithoutReply` 原先会扫描 B bootstrap 的 assistant。QA 已按 peer receipt ancestry 限定检测，并补 bootstrap 确认、B 最终确认各自的 ancestry。本人仅运行无模型的 `B bootstrap acknowledgment` 单测，1 passed；没有重跑真实模型，不能把此修复说成新的真实成功。

**最终不放行 G3。** 已有证据足以说明底层 A→B→A 路径曾真实打通，尚不足以交付“可靠自动协作”结论。剩余限制是模型侧任务接受与完整执行审计的稳定闭环，不应通过增加隐式授权、控制器代发或无限重试掩盖。保持第 7/8/9 次原失败结果；前端视觉、其他 CLI、首次登录流程均未在本轮通过。
