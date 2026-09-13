# G3 MCP 修复后真实验收

状态：修复后第一次真实运行全绿。本次限定 Claude 2.1.266 + MCP 的四输入往返已验证；此报告独立于前两轮失败记录，不覆盖其结论或产物。

入口仍为 [peer-messages-mcp-live.test.ts](../../../backend/tests/peer-messages-mcp-live.test.ts)，任务与全部断言未改变。新启动器 `/tmp/g3-mcp-postfix-run-live.py` 只更换日志、结果、独立配置目录前缀，不修改任务、认证方式或模型。版本预检仍为 Claude Code 2.1.266。

无模型预检：live 入口默认 2 pass / 1 skip；launch + screen 共 8 pass / 0 fail，日志 `/tmp/g3-mcp-postfix-preflight.log`。覆盖子进程自动建议配置的作用域，并保持未知淡色草稿拒绝写入。它们不是修复后的真实模型闭环证明。

本轮最多两次真实尝试，第二次仅用于明确实现或夹具缺陷；模型拒绝、认证或额度问题停止，不改任务措辞反复试探。保持四个逻辑输入预算（B 直接任务、A seed、两跳 peer）及 C 零输入；真实 native MCP 调用、精确 receipt / ancestry、HTTP / WS、全部 owned PID 清理均为硬验收项。

## 实际结果

`python3 /tmp/g3-mcp-postfix-run-live.py 1` 退出 0，真实测试耗时约 30.6 秒；同一入口的两个无模型检查也通过。本轮只执行一次真实运行，无第二次重试。实际 assistant 模型为 `claude-sonnet-5`，未覆盖模型选择。

日志 `/tmp/g3-mcp-postfix-attempt1.log`；原始结果 `/tmp/g3-mcp-postfix-attempt1-result.json`；[持久脱敏证据](evidence/g3-mcp-postfix/attempt1.json) 记录原始结果 SHA-256，[预检与执行源码摘要](evidence/g3-mcp-postfix/preflight.json) 记录版本及运行时文件 SHA-256。

- 三个真实 CLI 在模型输入前完成 MCP initialize / initialized / 成功 tools/list，精确四个工具；B 直接用户任务获得 READY、accepted 原生 receipt，idle 后才发送 A seed。
- A 实际 native MCP context + send，B 实际 context + inbox + send；工具输入双 pin、实际 tool_result 中 message/delivery ID 与存储信封严格一致。B inbox 确认原信 accepted 后才发送含 inReplyTo 的回信，工具调用 ancestry 属于对应入站原生 user。
- A→B 信封 `8a64c180-1ad3-40e4-b668-dfc115c19048` 的 accepted 原生 UUID 为 `e87e0cd1-96b2-4d73-b450-67693178750c`；B→A 信封 `7fedbb1e-cbdc-4316-9603-795c55ad5b24` 的 accepted 原生 UUID 为 `ea5b7d49-35b2-44a5-938b-56e84380d3cc`。两跳 delivery 均 accepted / revision 3，完整正文唯一，来源、实例、generation、command 与 native receipt 精确关联。
- A 最终 `FINAL 400` assistant UUID `71408e9f-6ecf-48f9-a23c-d371b3789fc3`，B 最终 `SENT 391` assistant UUID `b925c61b-8e22-4d1e-8e4f-66d686095112`。两者均属于正确入站 receipt ancestry，HTTP 保存的 role/UUID/完整内容匹配。
- WS 从先前 snapshot cursor 补收 A 39 项、B 46 项 changes，包含对应 accepted delivery revision，序列无重复。头部和末尾 cursor hash 留在证据中。
- A / B 各 2 个原生命令输入，C 为 0；三端 PTY / Claude PID 与 instance 均不变，C 无新增 user 正文和 inbox。没有为了写入消息另外启动 AI 进程。
- 解析 TUI 输出包含已由原生 assistant 精确验证的结果标记；这只证明后端终端输出，不宣称浏览器视觉已验收。
- 3 个 PTY、3 个 Claude、3 个 MCP wrapper、3 个正式 MCP server 共 12 个已记录 PID 全部正常退出，无清理介入和残留。

## 结论边界

本次证明受控 Claude MCP 协作能完成一次真实 A→B→A 计算任务，同时保留同一原生 TUI 会话及 API/WS 同步。未测试任意模型都自动回应、其他 CLI、浏览器交互、daemon 重启中的真实模型投递或长时间持续运行。真实草稿、忙碌、断线/重放、幂等等故障约束仍由已有无模型测试提供证据，不能宣称已在本次真实任务中逐一触发。

此前两次 terminal_draft 失败证据保留；本次没有改变草稿识别规则、发送权限、任务文本或输入预算，验证的是受控子进程关闭自动建议后的行为。

## 本轮完整回归

daemon 完整串行命令 `node --import tsx --experimental-test-module-mocks --test --test-concurrency=1 packages/terminal-daemon/tests/*.test.ts`：52 total / 50 pass / 2 skip / 0 fail，约 28.9 秒；日志 `/tmp/g3-mcp-postfix-daemon-final.log`。包括草稿、忙碌、同一原生提交及幂等相关既有用例，仍属于无模型故障验证，不把它们写成本次真实闭环触发过的故障。

backend 新增恢复用例冻结后执行 `npm test --workspace backend`：178 total / 171 pass / 7 skip / 0 fail，约 10.9 秒；日志 `/tmp/g3-mcp-postfix-backend-final.log`。`npm run typecheck --workspace backend` 通过，日志 `/tmp/g3-mcp-postfix-backend-typecheck.log`。新增故障用例的隔离方式和边界见 [恢复测试报告](g3-resilience-tests.md)；它们使用模拟 CLI / hook / transcript，不冒充真实模型断线验收。

[最终检查摘要](evidence/g3-mcp-postfix/checks.json) 保存本轮完整回归日志及新增测试文件 SHA-256。
