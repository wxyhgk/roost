# 同一终端切换 CLI 后的对话绑定

日期：2026-09-09。问题：同一 PTY 退出 OpenCode 后启动 omp，AI 对话仍显示 OpenCode 的记录与原生 ID。

## 原因与修复

`ai-agent-source` 用旧 binding.cliId 限制读取，导致运行时已识别 omp 后，回放在读取新身份事件之前就退出。旧 adopt 也固定复用旧 cliId，不能正确建立新 CLI 绑定。

现在只有以下证据满足时才跨 CLI 换绑：同一 terminalInstanceId，运行时明确识别新 CLI，旧正文有持久历史，连续 journal 中出现归属与新 CLI 一致的有效身份事件。扫描前后确认运行时、generation、revision 和源游标未变化；新绑定使用新 cliId/nativeSessionId，不继承旧 transcriptPath。

换绑后关闭旧 AI WebSocket，客户端重连读取新 generation。旧 OpenCode 历史保存在独立对话中，不合并到 omp，也不删除。

## 迟到与无归属事件

明确属于旧 CLI 的事件只推进 journal 游标，不投影身份、正文、状态或 transcriptPath。

独立反方发现补充缺陷：明确 omp 边界之后，无 agent 标签的旧 stop 仍能触发再次换绑。修复使用可选 `sourceRequiresCli` 元数据，跨 CLI 后必须继续匹配明确归属；此约束保存在现有 SQLite record_json，重建网关/bridge 后仍有效，不需要新数据库表或迁移。无法归属的事件保守跳过，不能混入新对话。

手动身份扫描同步处理：混合 journal 出现明确 CLI 标签后，旧无标签事件不能推翻明确候选；未知事件类型不能单独开启新身份。完全无标签的历史兼容路径仍可用于原有同 CLI 行为，但不能自证跨 CLI 切换。

## 验证与运行边界

独立 QA 使用真实 SQLite、bridge 和 HTTP/WebSocket，可控 runtime/journal 复现；初始跨 CLI 测试失败，修后专项通过。覆盖同 native ID 跨 CLI、旧历史保留、迟到旧事件、缺口、异步运行时变化和旧流关闭/新流只显示新正文。新增 14 条永久回归：10 条 CLI 切换、4 条身份扫描。

最终 backend 185 通过 / 7 跳过，bridge 7 通过，workspace-store 74 通过；backend/store 类型及源码边界、diff 检查通过。bridge 无独立 typecheck 脚本，共享 TS 代码经 backend 类型检查覆盖。结果见 [独立 QA](verification/ai-cli-switch-tests.md) 与 [反方复核](verification/cli-switch-skeptic.md)。

现场只读检查 8787 的 session-status 与 AI binding 元数据：当时唯一运行 omp 的终端，其运行时 CLI 与绑定 CLI 均为 omp。此检查未读取展示正文、没有向终端发送输入，也不替代人工从 OpenCode 退出再启动 omp 的完整浏览器重演。

只修改后端及共享 bridge，不修改前端或向现有终端发送指令。没有重启日常 daemon。当前终端中真实 OpenCode→omp 的浏览器视觉尚未独立重演；有 journal 缺口或缺少明确 CLI 归属时保留旧历史并报告诊断，不猜身份。
