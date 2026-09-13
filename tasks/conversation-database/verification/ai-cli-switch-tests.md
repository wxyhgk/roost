# 同一终端跨 CLI 身份切换：独立 QA

状态：修复后的默认回归全部通过；使用临时 SQLite、真实 bridge/HTTP/WebSocket 与可控 daemon journal，不启动真实 AI、不读取私人对话、不重启日常 daemon。

新增 [ai-cli-switch.test.ts](../../../backend/tests/ai-cli-switch.test.ts) 10 项，并在 [ai-identity.test.ts](../../../backend/tests/ai-identity.test.ts) 新增 4 项扫描回归。

## 已复现并保留的失败

- 初始 3 项全部失败：同 instance 的 live CLI 已从 opencode 变为 omp，pump 仍以旧 binding.cliId 做前置条件，连 journal 都没有读取。日志 `/tmp/ai-cli-switch-initial.log`。
- 反方指出明确 omp 边界后跟随无标签旧 stop 会再次换绑；独立永久测试复现 native ID 变为 old-late。日志 `/tmp/ai-cli-switch-mixed.log`。已覆盖同页、后续页、source 重建，以及从 SQLite 创建新 bridge 后的恢复，避免只依赖临时内存标志。
- 反方指出未知事件被身份扫描器跳过后仍可在投影阶段改绑；永久测试复现 unknown-native / 第二次 rebound。日志 `/tmp/ai-cli-switch-unknown.log`。

这些失败没有通过删除断言或允许混入旧内容来处理。

## 最终验证范围

- opencode→omp 同一 PTY/instance 切换创建新 generation，使用 omp CLI；即便 native ID 字符串相同，也保持不同 catalog conversation ID。
- 旧 OpenCode 正文持久保留，可通过旧 generation HTTP 接口读取；新快照只包含 omp 内容，transcriptPath 只来自新身份。
- 旧 WebSocket 收到 1008 关闭，新连接拿到新 generation，不留下永久静默的旧流。
- 已排队及更高序号的明确旧 CLI 回调不改回身份、不污染正文/path；序号仍按连续日志推进。
- 无 agent 标签不能证明跨 CLI 身份；完成明确跨 CLI 绑定后的严格来源要求经 SQLite 恢复仍有效。
- journal gap、异步读取期间 live CLI 再次变化保持旧绑定和正文，不采用过期页。
- 手工候选扫描过滤外国 CLI native ID/path，严格 afterSeq 不读已消费边界；明确候选后无标签旧事件不能推翻它，未知事件不能建立或替换身份。

## 最终检查

| 检查 | 结果 | 日志 |
|---|---:|---|
| backend 全套 | 185 pass / 7 skip / 0 fail（192 total） | `/tmp/ai-cli-switch-backend-final.log` |
| ai-session-bridge 全套 | 7 pass / 0 fail | `/tmp/ai-cli-switch-bridge-final.log` |
| workspace-store 全套 | 74 pass / 0 fail | `/tmp/ai-cli-switch-store-final.log` |
| backend + workspace-store typecheck | 通过 | 本轮工具输出 |
| source boundaries | 通过 | 本轮工具输出 |

未宣称用户当前真实 OpenCode/omp 进程已经完成现场验收，未做浏览器视觉操作。真实服务采用更新代码后的行为还需正常发布/重启路径验证。
