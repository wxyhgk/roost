# G3 MCP 真实闭环：独立反方

日期：2026-09-09。状态：**两次真实产物已独立复核；MCP 工具调用成立，完整 G3 闭环未放行**。

本轮仅审查测试代码与受控证据，不自行调用模型、读取凭证/私人会话或操作日常 daemon；不修改实现、QA 或前端文件。

## 运行前冻结

- 真实 Claude Code 2.1.266，在本次隔离 A/B/C PTY 加载新的四工具 MCP stdio 包，保留现有 observer、自动 binding 和唯一 daemon writer。禁用 builtin 工具，不用 Bash 脚本代替 MCP，不另开 headless 模型会话。
- 四个逻辑输入：B 的真实用户任务、A seed、A→B 与 B→A 两条 peer。最终 A commands=2、B commands=2、C=0；B 的任务确认不得被误当 peer 回信或拒绝。
- 模型真正发信必须有原生 MCP tool_use 和对应成功 tool_result；精确 pin/requestId/信封 ID 与持久发送者一致。工具加载、tools/list 或测试程序直调不能代替此证据。
- 两跳 accepted 必须精确对应目标 native user UUID 和封装正文，各只出现一次；工具回信与最终 assistant 必须处于对应 peer user 的 ancestry 下。
- HTTP assistant、peer revision 与 WS catch-up 一致；C 无输入、无消息。不能用 marker 出现在提示词/屏幕回显代替真实 assistant。
- MCP 凭证只由当前终端继承，不进入 prompt、配置文件、工具参数或产物。四工具权限准确限定本次 server；无 builtin、额外 MCP 或扩大批准。
- 最多两次真实尝试，只因实现/fixture 错误允许修复再跑；真实模型拒绝时停止，不改措辞继续试，不自动重发 seed。失败必须保留所到阶段与有限原生证据。
- 先 cleanup 服务、PTY、MCP 子进程和临时目录，再写产物；诊断失败不能跳过 cleanup。证据只含本次合成任务必要字段。

本轮即使通过，也只覆盖该 CLI/模型/任务与配置，不扩大成所有 CLI 或所有协作任务自动可用，更不覆盖前端视觉。

## 首次代码审查

已读取新增 `backend/tests/peer-messages-mcp-live.test.ts`：使用严格 MCP 配置、`--tools ''` 禁用 builtin、四个明确 MCP tool name；配置仅保存 ROOST_AGENT_* 环境占位符。透明 audit 子进程转发字节至真正新包 stdio，只记录 method/tool name 与 PID，不合成工具结果。模型须先真实 context 取得 pin；B 还须实际 inbox 读取 accepted 原信，再带 inReplyTo 发回。两跳原生 UUID/唯一正文、MCP 严格 JSON tool_result、最终 assistant ancestry 和 HTTP/WS 均有断言。

本人仅执行新文件的无模型 `native MCP evidence` 测试，1 passed；验证文本数组解码、拒绝 substring/error/不匹配结果，不是模型调用证明。

发现待修：**G3-MCP-L1** cleanup 原先只检查 PTY/Claude PID，未检查透明 wrapper 与真正 MCP child；且仅记录 alive，没有阻止 `success:true`。已要求 QA 收集本次 audit 的 owned PIDs，停止后有界检查全部进程，残留不能成功。另 partial 的 toolVerified 原先只说明原生发送工具链，并不含 B 回复 ancestry；应分别标注以免失败产物被过度解释。

L1 已修并只读确认：cleanup 将 audit 记录的 wrapper/server PID 纳入，停止 owner 后有界等待，仅对本次 owned PID 清理；残留使 success=false 并断言失败。partial 已分为 sendToolVerified / peerAncestryVerified。模型输入前额外要求 A/B/C 的实际 initialize、initialized 与四工具发现完成。

本人运行新版文件默认模式：**2 passed，1 skipped**；包含真实 stdio 透明审计壳的无模型 smoke。运行前无新增阻塞，可按冻结预算开始。该结论不等于真实闭环通过。

## 第一次真实运行复核

已独立读取 `/tmp/g3-mcp-live-attempt1-result.json`：`success:false`，三 CLI 在模型输入前完成 MCP discovery；B bootstrap accepted 并真实 READY。A→B 的 exactReceiptVerified / sendToolVerified 均为 true。B 已真实调用 context、inbox 读取 accepted 原信，再带正确 inReplyTo 发回；sendToolVerified / peerAncestryVerified 为 true。

回信 B→A 仍为 queued revision 2，无 nativeMessageId；A 只有 seed command，没有回信 command。QA 报告门禁原因是 terminal_draft，60 秒内未推进。**这次不属于模型拒绝或 MCP 不可调用，也不等于完整双跳通过。** 无末屏诊断时不能确定真实草稿还是界面误判；不得忽略草稿门禁或清空输入求通过。

cleanup 记录 12 个 owned PTY/Claude/wrapper/server 全部 alive:false，且 cleanupRequiredIntervention 为空。本轮首次真实工具链证据明确，但完整 receipt、最终 assistant 与 HTTP/WS 门禁尚待实现原因定位后的有限复验。

## 建议文字与真实草稿：独立源码判断

只读当前 `claude-screen.ts` 与 `ai-command-owner.ts`，以及安装的 2.1.266 可见源码：CLI 的 promptSuggestion 状态独立于输入状态；渲染 hook 在 hasInput 或 isAssistantResponding 时不给出 suggestion。`promptSuggestionEnabled` 默认开启；CLI 源码明确 `--prompt-suggestions` 的结构化事件仅用于 print/stream-json，不能直接假定现有 TUI observer 已得到这些事件。

当前后端只对白色边框内、光标起点、特定 muted `Try "..."` 占位放行，其余文本视为草稿。`inputEpoch` 只证明有无经过 daemon 的非终端应答输入，不证明 CLI 未自动恢复草稿、未回填编辑状态，也不单独证明非空文本来源为 suggestion。

严格修复条件：必须先有真实末屏/光标/cell 样式证明目标错误，再用锁定版本的 renderer 证据区分建议来源。光标起点或灰色文本单独不能放行：用户可把光标移回行首，主题也可让真实草稿灰色。若辅助使用 epoch，必须限定同一 instance/generation、原生输入已确认、可信空白基线之后没有用户输入、无 dialog、屏幕 settled，并保留最终写入前 epoch/version 再校验。CLI 内部恢复/预填仍需单独排除；证据不足就保留草稿状态。

必要反例：灰色真实草稿+Home；Tab 接受建议后移回行首；先输入后删除一部分；外部编辑返回的预填草稿；Stop 后仍显示旧输入的瞬态帧；建议生成与用户键入竞争；恢复/换绑重置基线。可用正式 setting 关闭建议验证一个隔离配置，但应明确这是配置限制，不是可靠自动识别建议的证明。

更小且可接受的兼容边界：只对已启用 GUI send 的受控交互式 Claude 子进程设置 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`，不改屏幕识别/草稿/inputEpoch 门禁，也不写全局配置。已独立确认 [Claude 官方变量说明](https://code.claude.com/docs/en/env-vars) 与本地 Happier `buildClaudeUnifiedTerminalSpawn.ts` 的同样设计：在进程边界禁用这种有歧义的预测输入，而非放宽草稿判定。正常终端、help/headless/nested 分支保持其原本环境。

此修改需无模型回归确认受控分支覆盖已有 true、非受控保留用户值、env 不回流 daemon、分支参数过滤正确。即使实现通过，当前两次预算内未运行修后版本时，不能宣称真实闭环已修复通过。


## 第二次诊断与最终裁定

已独立读取 `/tmp/g3-mcp-live-attempt2-result.json`。A 的实际末屏输入行是 `❯ check inbox for the reply`，光标 x=2/y=37，文本非空 cell 全部 dim=true、fg=-1，提示符本身非 dim；control 为 terminal_draft、inputEpoch=1。该 epoch 对应测试启动命令，夹具未再键入真实草稿。回信的 reason=terminal_draft，仍 queued；A→B 精确 receipt 成立，B 的真实 MCP send 和原信 ancestry 成立。12 个 owned 进程自然退出，无 cleanup intervention。

结合受控输入历史、CLI renderer 源码与公开建议变量，这次证据支持“自动建议与保守草稿门禁冲突”的定位。修复选择是在受控 Claude 子进程禁用建议，保持真正草稿保护，而不是把灰色文字都当空白。

已只读审查 root 的 `claude-launch.ts` 改动：GUI-send 开关在生成 wrapper 时捕获，仅对应 child env 设置 false；help/version、nested 与 print 排除，daemon/用户持久设置不变。已提醒已有 observe 条件还涵盖管理子命令，若承诺严格仅 TUI 则需明确排除；相关启动边界回归由 QA 负责。

**本轮两次真实预算已结束，无第三次模型调用。最终不放行完整 G3。** 能确认的成果是三 CLI 真正加载新 MCP 包、模型真实 context/inbox/send、可信双 pin、第一跳 native receipt 和 B 的真实回信动作；不能确认修复后的第二跳 receipt、最终 A assistant 与 HTTP/WS 完整闭环。无模型启动回归通过也不会改写这两次 `success:false`。

最终范围澄清：本轮不新增管理子命令解析；准确条件是“创建启动器时 GUI send 开启、顶层 observer 生效、非 print 的子进程”。其中管理命令没有 composer，但也会继承该 false 值，不能写成已逐一识别所有交互/管理命令。父级已在阶段 15 文档采用此表述，未扩大实际权限，因此此项作为明确边界接受。QA 报告 28 个启动场景的 5 项回归通过；这是 QA 结果，本人未将其计为新的真实模型复验。
