# 主流 AI CLI 同 TUI / GUI 适配盘点

核查日期：2026-09-09。范围是实际 CLI 程序，不是其可选模型供应商。本次未修改用户全局配置、未重启日常 daemon、未调用真实模型。Happier 本地 checkout：`d06e287b`。各 CLI 的“能以 ACP 启动”不等于“能同时连接已运行的 TUI”。

## 结论及实施顺序

| CLI | 已有可用身份/正文来源 | 写入同一个现有 TUI 的边界 | 本轮/下一项 |
| --- | --- | --- | --- |
| Claude Code | 已实现进程 scoped hooks + native JSONL | 本项目已有默认关闭、2.1.266 限定的 PTY 排队实现；真实发送/草稿/权限已由前轮测试 | 保持版本/能力隔离，不套用其他 CLI 的 prompt 规则 |
| OpenCode | 本项目已有指定 server + sessionId 的 HTTP snapshot reader | 首选连接确属于原 TUI 的 server，再走 session prompt；不能新建 server 假称同会话 | OpenCode 专属调研/实现由其他 agent 负责 |
| Qwen Code | Gemini 派生但需按当前 Qwen 格式与 hooks 实证 | SDK/headless 是另一种运行模式；按 hook 身份和 native receipt 逐步接入 | Qwen 专属调研/实现由其他 agent 负责 |
| Codex | 本项目已有 rollout JSONL reader，验证 session_meta.id | Happier 采用 local/remote 控制切换与 resume，不是并发向两个拥有者发送 | Codex 专属 agent 补启动身份；控制权切换需单独验收 |
| Gemini CLI | 本机 0.22.4 的 session JSON + SessionStart/BeforeAgent/AfterAgent hooks | ACP 是另起模式；没有证据可直接向现有任意 TUI 发送 | 本轮增加独立 Gemini reader；自动启动与发送不可由只读 reader 冒充 |
| Grok Build | 本机官方 1.0.13，plugin hooks / ACP / shared leader | 本机 help 明确 shared leader 支持多个 clients；需证明客户端连接同 leader + 同 session | 值得专项验证 leader/socket，优先于猜 PTY 输入；不可误用社区同名 grok-cli |
| Oh My Pi (omp) | 本项目已有 OSC identity + v3 JSONL reader | 本机 18.1.11 提供 `--extension`、`--mode rpc`/`rpc-ui`；独立 RPC 不等于现有 TUI | 优先用加载到同 TUI 的 extension API，确认队列/receipt 后接统一命令账本 |

## 本轮已落地：Gemini JSON reader

文件：`packages/ai-transcript/src/gemini.ts`、`packages/ai-transcript/tests/gemini.test.ts`。公共注册及 backend source 由集成人员负责，不能单凭这两文件宣称用户终端已自动同步。

本机官方 npm 源码依据：

- `/opt/homebrew/lib/node_modules/@google/gemini-cli/package.json`：0.22.4。
- 对应 `node_modules/@google/gemini-cli-core/dist/src/services/chatRecordingService.d.ts`：ConversationRecord 为 `sessionId, projectHash, startTime, lastUpdated, messages`；message 为 `id,type,timestamp,content`；gemini message 可有 toolCalls/thoughts。
- 同目录 `.js` 的 writeConversation 使用 writeFileSync 重写整个 JSON。不能复用 JSONL 的 offset 追读器。

实现约束：只读明确绝对路径；核验 native sessionId 及 projectHash/startTime 身份，拒绝复用身份；4 MiB / 2000 消息上限、读取前后 stat 一致；坏 JSON/写到一半不提交；稳定 `gemini:<sessionId>:<messageId>` 支持后续正文修订。正文64 Ki字符、耐久详情256 Ki字符，工具调用和结果关联，已记录 thought 映射；未知部分标记 partial，不输出原始图片/私有字段。coverage 明确 `bounded_snapshot`。这是有界全快照读取，没有声称无限历史或增量字节读取。

测试三个用例通过：中文与工具关联/修订/重复读取；错误身份、身份复用、重复消息ID、半写JSON、体积上限；未知parts及正文/详情上限。未做真实 Gemini 模型回合验证。

## Gemini hooks 的版本差异

[官方 hook reference](https://geminicli.com/docs/hooks/reference/) 提供 session_id、transcript_path 及 BeforeAgent/AfterAgent 生命周期。当前安装包 hookEventHandler.js 与 types.d.ts 也含这些字段，可作为真实身份链而不是按最近修改时间找文件。

本机 0.22.4 extension-manager.js 从扩展的 `hooks/hooks.json` 加载 hooks，但受 `tools.enableHooks` 控制；默认 false。它支持 `${extensionPath}` hydration。settings.js 支持 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`，但覆盖该变量可能丢掉用户原 system settings，不能不加合并就照搬临时配置。

[官方 extension reference](https://geminicli.com/docs/extensions/reference/) 是最新行为；本机旧版本必须另外核对可临时加载的扩展参数。可以复用 Qwen launcher 的目录/IPC/token 基础设施，但不能假定参数名、开关、hook 返回控制语义完全一致。观察 hook 应为空输出且 fail-open，不替用户批准权限。

## Grok 必须先分清实现

本机 `/Users/you/.local/bin/grok` 指向 `.grok/bin/grok`；`grok --version` 为 `grok 1.0.13 (5e9a58528b76)`，help 标题 Grok Build TUI。它对应[官方 Grok Build](https://docs.x.ai/build/overview)，不是 [superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli) 社区 Bun/OpenTUI 程序。

本机 `grok agent --help` 的实证：

- `stdio`：ACP stdio；`serve`：WebSocket server；`leader`：shared leader。
- `--leader`：连接 shared leader，多个客户端共享后端；`--leader-socket` 可指定隔离 socket。
- `--plugin-dir`：仅本进程加载 plugin；文案提示自动信任其 hooks/MCP，因此应只生成自有无控制副作用观察器。

[官方 CLI reference](https://docs.x.ai/build/cli/reference) 与 [headless/ACP](https://docs.x.ai/build/cli/headless-scripting) 区分 TUI/headless/ACP。Happier 的 `apps/cli/src/backends/grok/acp/launch.ts` 使用 `--no-auto-update agent stdio`；backend.ts 的 `x.ai/interject` 扩展以 queued 响应表示接收，不能套在不支持该扩展的 CLI 上。这里尚未验证 leader 的会话 attach 和并发控制语义，不宣称已经双向接通。

## Happier 的可借鉴边界

本地 `apps/cli/src/backends/codex/runCodex.ts`、`codexLocalLauncher.ts` 及 integration tests 明确 local/remote 切换、resume 同一 identity、resume 失败拒绝偷偷新建远端会话。我们应借鉴“能力声明 + 身份证明 + 接收证据 + 单控制者”，不把 headless 进程启动成功作为原 TUI 同步成功。

Gemini backend.ts / cli/detect.ts 显式探测 `--acp` 与旧 `--experimental-acp`。不同 CLI/版本必须保留专属启动参数与验证，不应把适配器抽象成通用 `sendEnter()`。

## 完成的判定

每个 CLI 分开报告：识别 → 自动身份 → 正文/修订 → 状态 → GUI 发送 → 接收确认 → 重连/权限/草稿场景。只有前四项完成时只能称只读同步，不能称双向适配完成。共享账本、幂等键和失败语义可以复用；专属协议证据不够时应明确 unsupported，不偷偷退回猜测键位。
