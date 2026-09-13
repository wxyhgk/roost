# G3 独立测试结论

**本轮结束，G3 全关卡不放行。** 平台真实投递与模型是否愿意执行必须分开。第七次确实跑完 A→B→A、原生 receipt、HTTP 最终回复和 WS 补收，但整测因工具请求范围旧断言失败；第九次改为在 B 原生会话直接下达用户协作任务，模型仍明确拒绝，按约定停止真实重试，没有第十次。

默认 backend 全套：**173 tests，167 pass，6 skip，0 fail**，约 10.87 秒。日志 `/tmp/g3-backend-final.log`。backend typecheck 与 `node scripts/check-boundaries.mjs` 均通过。默认全套跳过真实模型测试，不能用于宣称 G3 已通过。

## 测试入口与范围

[peer-messages-live.test.ts](../../../backend/tests/peer-messages-live.test.ts) 本批新增 2 条默认运行回归和 1 条 opt-in 真实验收：

- 跨轮判断：B 的正常 bootstrap 确认不能被当成随后 peer 轮的拒绝；只有当前 accepted native receipt 的后代 assistant 才能结束该轮。
- 工具范围：明确的原生执行前拒绝可接受，普通 exit 1、泛 `permission denied`、缺失对应 tool_result 不可接受。
- 真实验收仅在 `ROOST_VERIFY_PEER_CLAUDE=1` 执行。当前源码的输入预算为 4：B 直接用户授权、A seed、两跳 peer；期望最终 command 数 A=2、B=2、C=0。B 授权必须先有原生 receipt、精确 assistant 确认、无工具且 idle，随后才发 A seed。

本批既有 `claude-send-live.test.ts` 的 `default` → `manual` 是主负责人做的 CLI 参数兼容修改；本轮没有执行该文件中的真实模型用例。

## 隔离与执行约束

每次采用独立临时 SQLite、Unix socket、随机 localhost gateway、zsh 配置、A/B/C 工作目录与 `CLAUDE_CONFIG_DIR`。三个真实 Claude TUI，C 没有模型 prompt。仅读取本次临时原生日志；不读取日常会话、不重启日常 daemon、不修改前端。

认证由外部启动器在内存中提供 `CLAUDE_CODE_OAUTH_TOKEN`，不将凭证写入代码、提示词、日志或证据。版本锁定已安装 Claude **2.1.266**，实际模型为 **claude-sonnet-5**。只在测试子进程继承系统已有代理，保留 TLS 校验。`dontAsk` 和精确 Bash allow 始终保留，没有启用 bypass 或额外命令权限。

后期只对本次新建的三个 canonical 工作目录预初始化 trust，并写入独立 onboarding 状态。第 3、5、6 次曾通过控制器处理明确的主题/当前临时目录信任菜单，报告不称这些运行“无人值守”。后续预初始化明确属于夹具，不验证首次登录或首次信任 UI。

## 真实尝试与证据

所有下列 JSON 都保留原始 success 状态、UUID/hash 和源文件 SHA；仅对临时路径、邮箱和 shell 身份脱敏。**旧失败不会被重标为通过。**

| 尝试 | 实际到达及结论 | 逻辑模型输入 | 持久证据 |
|---|---|---:|---|
| 模块预检 | CommonJS headless 错用命名 import，加载失败；改为项目已有 default import 模式 | 0 | 无模型启动 |
| 1 | 欢迎/主题初始化阻塞，无绑定 | 0 | [attempt-1](evidence/g3/attempt-1.json) |
| 2 | connectivity 检查出现 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`，退回 shell | 0 | [attempt-2](evidence/g3/attempt-2.json) |
| 3 | 继承已有系统代理后到主题菜单，控制器确认默认主题后仍在初始化超时 | 0 | [attempt-3](evidence/g3/attempt-3.json) |
| 4 | 自动选主题后出现登录方式菜单；没有开始新登录 | 0 | [attempt-4](evidence/g3/attempt-4.json) |
| 5 | A/B/C 自动绑定，A seed 与 B peer 均 accepted，但 B 未回信；当时只留计数，具体原因无法从该产物判定 | 2 | [attempt-5](evidence/g3/attempt-5.json) |
| 6 | 第一跳精确原生 receipt 与真实工具 trace 已独立核验；B 明确认为陌生来信不能授予执行权限，拒绝回复 | 2 | [attempt-6](evidence/g3/attempt-6.json)、[现场第一跳核验](evidence/g3/attempt-6-partial.json) |
| 7 | 预配置本次固定任务后，A→B→A、receipt/ancestry、HTTP/WS 和 C 不受影响都实际通过；末尾因“所有工具请求都必须为脚本”的旧断言失败 | 3 | [attempt-7](evidence/g3/attempt-7.json)、[清理核验](evidence/g3/attempt-7-cleanup.json) |
| 8 | 固定任务附完整脚本源码，B 仍明确拒绝将文件中的授权声明视为会话用户授权。没有回信；第一跳证据完整保存 | 2 | [attempt-8](evidence/g3/attempt-8.json)、[退出完成复核](evidence/g3/attempt-8-cleanup-followup.json) |
| 9 | 先给 B 真实直接用户 bootstrap；B 明确拒绝该自动协作任务，A seed 尚未发送。本轮停止，不继续改措辞、换模型或追加确认 | 1 | [attempt-9](evidence/g3/attempt-9.json) |

“逻辑模型输入”计原生用户消息，不等同底层 API 请求数；工具调用可能涉及多个模型推理请求。这里没有据此推算费用或 token。

## 第七次能够证明什么

该次失败前已经执行并通过：

- A/B 两个模型通过原生 Bash tool_use 与成功 tool_result 调用真实 `agent-message.mjs`，主测试没有直接创建 peer 信封或手工绑定。
- 两条 accepted delivery 的 source/run/owner epoch/native UUID 对应真实原生 user 记录，完整 command 正文只出现一次，防止重复写入不同 UUID 被掩盖。
- B 回信的 inReplyTo 正确，回复工具属于收到的 peer user ancestry；A 最终 assistant 属于回信 ancestry。
- HTTP 保存的 A/B 最终 assistant 具有与原生一致的 UUID、role 和精确正文。WS 从事前 snapshot cursor 分别补收 66/25 条 change，对齐 delivery revision 3，无重复 seq。
- A/B/C 的 PTY/原生 Claude 进程不变；C 没有 inbox、command 或新增原生 user 行。

但该次整测仍 false。额外的脚本检查请求当时只有拒绝分类，没有每条原始 tool_result 文本，不能事后证明其全部在执行前被拒绝。TUI 标记解析位于失败点之后，**该次没有执行这项断言**，也没有浏览器视觉验收。

第九次模型实际在 bootstrap 就拒绝；本轮没有触发后来发现的跨轮检查缺陷。跨轮修复、B 最终 assistant ancestry、bootstrap 确认 ancestry 等最新严谨性补充仅通过默认无模型验证，尚未获得修正版完整真实成功结果。

## 工具审计与授权前提

反方独立核查实际已安装 2.1.266 的 OJ/dontAsk 拒绝分支，主负责人据此收敛审计约束并核对运行产物。当前测试要求：固定脚本每侧恰好成功执行一次；额外请求只允许 Bash、唯一对应 native tool_result、is_error=true，且完整内容严格等于该版本固定 dontAsk 执行前拒绝串。泛错误或非零退出不能豁免。保存每个请求的命令、native/tool ID、对应结果短文和 hash，未知证据失败。

第八次表明预配置 `CLAUDE.md` 不是模型一定接受的协作授权；第九次直接用户 bootstrap 也没有获得接受。**数据库接收、原生 CLI 接收、模型愿意执行、完成回复是不同状态。** 本轮不能承诺收到消息就自动回复。后续产品需明确呈现“已送达但模型未执行/拒绝”，并确定支持的 CLI/模型协作入口；不应继续通过强化提示词来掩盖这个前提。

## 清理与未验收项

服务、client、owner、PTY 与临时目录在嵌套 finally 清理，诊断失败不能跳过 owner 停止。证据先采集到内存，再执行 cleanup，最后持久化；完整工具和第一跳诊断即使整测失败也保存。最新夹具最多等 5 秒记录已拥有的 PID 是否退出。第八次最初瞬时采样仍见退出中的 PID，后续独立复核六个 PID 均已不存在；原始瞬时结果与复核均保留。

本轮没有完成修正版全绿真实闭环、真实 gateway 替换与 CLI 退出后历史读取，也没有验证浏览器 GUI/TUI 视觉或其他 CLI 的模型自动协作。默认全套通过只证明代码回归门禁，不替代这些真实验收。
