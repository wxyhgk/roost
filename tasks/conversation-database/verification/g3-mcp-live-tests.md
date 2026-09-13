# G3 原生 MCP 协作独立验收

状态：两次真实 MCP 验收均整体失败，已定位自动建议触发草稿门禁，并完成受控启动配置修正的无模型验证；G3 完整往返暂不放行。默认无模型检查为 2 pass / 1 skip。

入口：[peer-messages-mcp-live.test.ts](../../../backend/tests/peer-messages-mcp-live.test.ts)。默认 2 个检查通过、1 个真实测试跳过：严格解析原生 MCP tool_result（字符串或文本块数组），拒绝错误、子串和缺失关联；透明审计壳启动正式 stdio 服务，真实 initialize / initialized / tools/list，准确发现四项工具并正常退出。此部分不请求模型。

真实测试限定 Claude 2.1.266，三个临时 PTY 与独立配置、数据库、socket。保持 observer 自动绑定；禁用全部内置工具，只允许 workspace_messaging 下 context/send/inbox/outbox。MCP 配置仅保存四个 ROOST_AGENT 环境变量的符号引用，凭证由进程环境传递，不落测试配置。审计壳透传正式 MCP 服务的字节，仅记录协议方法、工具名、发现成功及本次进程 PID。

模型输入最多四次：B 的直接用户计算任务、A 的种子任务、A→B 与 B→A 两封平台原生投递。C 不提交模型输入。任务为协作计算 (17 × 23) + 9，无 CLAUDE.md 授权、Bash 脚本工具、控制器代发或手工绑定。必须先证明三个 CLI 完成成功的 MCP 工具发现再发送模型任务。

验收要求：实际原生 MCP 调用与结果严格关联双 pin、message/delivery ID；B inbox 读取 accepted 原信后才回复；两跳 accepted UUID 精确对应唯一原生 user 全文，回复工具及 assistant 均属于正确原生 ancestry；API 保存精确 assistant UUID/正文，WS 补收 accepted revision；PTY 与 Claude PID/instance 不变，C 无新增输入。解析 TUI 标记只作原生 assistant 证据的辅证，不代表浏览器视觉验收。

清理覆盖 PTY、Claude、MCP wrapper 和正式 stdio 子进程。先正常退出，再有界清理本次明确所属 PID，记录介入与最终存活情况；任何残留都不得报告成功。失败时保留脱敏 partial receipt、send-tool 与 peer-ancestry 分项证据。

真实尝试最多两次，第二次仅用于已证实的实现或夹具问题；模型拒绝、认证或额度错误即停止，不换模型、不改任务措辞反复试探。运行结果与默认 backend 全套结果待追加。

## 第一次真实运行

日志 `/tmp/g3-mcp-live-attempt1.log`，原始结果 `/tmp/g3-mcp-live-attempt1-result.json`；持久脱敏证据 [attempt1.json](evidence/g3-mcp/attempt1.json)。真实测试耗时约 86.9 秒，失败于等待两跳 native receipts accepted，不是模型拒绝。

- 三个真实 Claude 均完成 MCP initialize / initialized / tools/list，成功发现精确四项；B 直接用户任务获精确 READY、accepted 原生 receipt，并在 idle 后提交 A 唯一种子。
- A 真实调用 context + send，A→B accepted，精确 native UUID、唯一全文与 MCP tool_result 信封关联通过。
- B 真实调用 context + inbox + send，inbox 读到 accepted 原信，实际回复带正确 inReplyTo，reply tool ancestry 已精确关联 B 的入站 native receipt。B 输出 SENT 391。
- B→A 信件已经持久保存，现场只读数据库观察到 queued / terminal_draft。A 没收到第二条 command，最终计算尚未发生；没有强行清 composer 或绕过生产写入门禁。
- 当次实际三个原生输入：B 用户任务、A seed、A→B；未达到预定第四个输入。C command 数为 0。API 最终 assistant / WS 完整闭环尚未执行，不能沿用旧轮通过事实。
- 12 个本次 PTY、Claude、审计 wrapper、正式 MCP server PID 全部正常退出；无需 TERM/KILL 介入，无残留。

首次失败产物仅有启动末屏，未保留完成第一轮后的 composer 屏幕，因此目前不能裁定 terminal_draft 是真实草稿、建议占位还是识别缺陷。夹具已补下一次失败的受控尾屏、光标位置、composer cell 样式、control 与只读 snapshot 摘要；这不构成已修复业务缺陷的证据。第二次已按相同任务和启动配置复现，见下节。

## 默认回归

`npm test --workspace backend`：176 个测试，169 pass、7 skip、0 fail，约 11.4 秒；日志 `/tmp/g3-mcp-backend-default.log`。本批新增 2 条默认无模型回归和 1 条 opt-in 真实测试（在默认命令中跳过）。此结果不替代上述真实失败，也不宣称第二跳已完成。

## 第二次诊断复现与无模型修复验证

唯一剩余的第二次没有修改任务、权限、输入次数或建议设置；只增加受控诊断。原始结果 `/tmp/g3-mcp-live-attempt2-result.json`，日志 `/tmp/g3-mcp-live-attempt2.log`，持久证据 [attempt2.json](evidence/g3-mcp/attempt2.json)。两次实际模型均为 `claude-sonnet-5`。

第二次仍整体失败于第二跳 native receipt 超时。A→B 原生 receipt / 唯一正文 / MCP 结果关联通过，B 的实际 inbox accepted→send 回信 ancestry 通过；B→A 仍为 queued / terminal_draft。首次三端加载与 B bootstrap 成立，并非 MCP 不可用或 B 拒绝回应。

失败时 A 的实际 composer 是 `❯ check inbox for the reply`。光标位于 x=2、y=37；正文所有非空字符 cell 都是 `dim=true`、默认前景色 `fg=-1`，prompt 字符本身不是 dim。测试没有输入这些文字，这是 CLI 生成的淡色建议。原分类器只将特定 `Try "…"` 形式的淡色内容判为空，其余保守地判为草稿。因此新证据明确指出本次建议触发门禁；未绕过门禁或把灰色文字一概当成可覆盖的输入。

主负责人修正启动集成：仅在启用 `ROOST_CLAUDE_GUI_SEND=1` 的受控交互式 Claude 子进程里设置 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`。保留原草稿检测，不改变持久配置、调用者环境、help/version/print 或 nested 调用。该修改没有再次请求模型，因此不得将修复后的真实闭环称为已验收。

独立新增 [claude-launch.test.ts](../../../packages/terminal-daemon/tests/claude-launch.test.ts) 两个测试，28 个真实 zsh + 假 CLI 场景覆盖控制模式开启/关闭、原建议值 true/不存在、普通参数/help/version/-p/--print/--print=/nested，验证精确子进程环境、父环境保留及参数不变。Focused 5/5 通过，日志 `/tmp/g3-mcp-claude-launch.log`。

两轮所有已记录的 12 个本次 PTY/Claude/wrapper/MCP server 进程均正常退出，无需额外清理介入。两次真实预算已用尽，无第三次运行；G3 完整往返仍不放行。

## 修正后的最终全套

- daemon：`node --import tsx --experimental-test-module-mocks --test --test-concurrency=1 packages/terminal-daemon/tests/*.test.ts`，52 total / 50 pass / 2 skip / 0 fail，约 27.0 秒，日志 `/tmp/g3-mcp-daemon-final.log`。包含新增两条启动测试及主负责人新增的未知淡色内容仍拒绝写入回归。此命令明确串行执行，不宣称默认并行调度通过。
- backend：`npm test --workspace backend`，176 total / 169 pass / 7 skip / 0 fail，约 11.1 秒，日志 `/tmp/g3-mcp-backend-final.log`。

[验收文件与日志摘要](evidence/g3-mcp/checks.json) 保留 SHA-256 便于核对。本批两次真实结果仍为 false；修后环境注入与保守写入边界已经无模型验证，实际禁用建议后完整往返留待后续有界真实验收。
