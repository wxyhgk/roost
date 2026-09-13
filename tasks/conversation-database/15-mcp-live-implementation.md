# 真实 CLI 加载 MCP 与通讯验证

日期：2026-09-09。状态：两次真实尝试结束，MCP 加载与原生发信成立，双向闭环尚未放行；已修复受控启动的建议文字兼容问题，修后真实闭环未重跑。

## 本轮范围

三个临时 Claude TUI：A 发任务、B 计算并回信、C 保持空闲。MCP server 使用正式 `@roost/agent-messaging` 入口，发信必须来自原生模型的 MCP tool_use，不通过测试程序代发。

任务仅涉及合成数字计算：B 计算 17×23，A 收到后加 9。用户先在 B 的原生会话说明这次协作任务，再给 A 提交任务。最多四条原生逻辑输入：B 用户任务、A 用户任务、两跳 peer；它不等于四次底层模型 API 请求。不创建以文件声明授权的 `CLAUDE.md`，来信来源标识保持。

使用现有 Claude 版本门禁、observer 自动绑定、双身份 pin、单 writer 和持久信箱。CLI 内置工具关闭，只允许四个本次 MCP 工具。无前端修改、日常 daemon 重启或私人对话读写。

## 分工

| 角色 | 本轮职责 |
| --- | --- |
| database_test_review | 独占新真实测试、测试夹具、隔离运行、结果与证据 |
| qwen_adapter | 独立审查启动条件、权限、原生工具/回执对应与最终结论 |
| conversation_runs_impl | 本机 CLI 加载参数、环境继承与官方契约核验 |
| 主 Agent | 启动器审查、共享业务缺陷修复、相关门禁与阶段交付 |

## 必需证据

1. 实际 Claude 加载 MCP；只有四个允许工具，启动环境不将凭证写入配置或日志。配置里的环境符号引用与实际值分别对待。
2. A/B 自动生成不同 nativeSession，对应同一稳定 conversation/source/run；不手工绑定或伪造 hook。
3. 发信 tool_use 的 recipient、requestId、双 pin 与 SQLite 信封一致；成功 tool_result 必须解析为结构化内容，不靠子串匹配。B 回信明确引用原 messageId。
4. 两跳 accepted 对应唯一完整原生 user 正文及准确 native UUID。B 回信工具与最终回答属于收到原信后的 ancestry；A 回答属于收到回信后的 ancestry。
5. HTTP 持久历史与 WS changes 对应同一原生消息、信封与 revision。实际终端流仅作辅助证据，浏览器视觉仍独立验收。
6. 同一 PTY PID/instance 与 Claude 进程保持，C 不收到输入或信件；测试退出清理自己创建的资源。

## 调用边界

本轮最多两次真实尝试；第二次仅用于已确认的实现或夹具问题。本轮第二次修补第一次失败时未保留末屏的诊断缺口，保持原任务与配置受控复现；没有预先宣称业务问题已修复。出现模型明确拒绝、认证或用量限制时停止本轮，不改措辞反复请求、换模型或追加控制器确认。旧 Bash 方案的失败证据保持不变。

认证沿用已审查的临时配置及内存环境方式，测试代码本身不读取个人 Keychain。前置检查、默认跳过、模型真实调用和最终闭环分别记录。结果见 [独立测试](verification/g3-mcp-live-tests.md) 与 [反方](verification/g3-mcp-live-skeptic.md)，记录形成前不预写通过。

## 实际结果与修复

两次都证明三个真实 Claude 成功发现四项 MCP 工具；A 原生调用 context/send，B 收到唯一原生回执并通过 context/inbox/send 回复原信。回信已落库，但投递停在 `queued / terminal_draft`，没有到达 A。两次的 12 个自有 PTY/Claude/MCP 进程均正常退出，不需要强制清理。

第二次末屏保留了 A 输入框的 `check inbox for the reply`，光标停在 x=2，文字所有非空 cell 均 dim=true；测试期间没有手动输入该内容。建议文字与草稿检查发生冲突。不能仅凭淡色或光标位置将未知文字认作空白，因为真实恢复草稿也可能具有相同外观。

[claude-launch.ts](../../packages/terminal-daemon/src/claude-launch.ts) 现在只在创建启动器时启用 `ROOST_CLAUDE_GUI_SEND=1`、顶层 observer 生效且非 print 模式的 Claude 子进程设置 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`。不修改全局配置、父进程环境、screen 判定、inputEpoch 或单 writer 门禁；帮助、版本、嵌套及 print 调用保留原设置。已运行的 CLI 不受这次源码修改影响。

该变量是 [Claude 官方环境契约](https://code.claude.com/docs/en/env-vars)。本地 Happier 的 [buildClaudeUnifiedTerminalSpawn.ts](../../research/third-party/happier/apps/cli/src/backends/claude/unifiedTerminal/buildClaudeUnifiedTerminalSpawn.ts) 中 `buildClaudeEnv` 同样通过关闭建议避免放宽草稿检查。这里借鉴的是启动配置边界，不复制其投递实现。

修复后只做无模型回归和类型检查，不追加第三次真实尝试。下一次真实验收需在此修复的新启动器下重新证明两跳 native UUID、A 最终 assistant ancestry、HTTP/WS 同步以及 C 无输入；不能把发信工具成功或默认测试通过当成完整闭环通过。

最终无模型检查：daemon 串行全套 50 通过 / 2 跳过，backend 全套 169 通过 / 7 跳过；两包类型、源码边界、差异空白与本批文档链接检查通过。启动测试使用真实 zsh 和假 CLI，证明子进程设置及旁路保留，不代表真实 Claude 修后往返。淡色文字回归证明没有将草稿检测放宽为“灰色即空白”。
