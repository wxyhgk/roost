# Qwen Code：同一 TUI 的结构化通道

2026-09-09。核对本机 `@qwen-code/qwen-code` **0.23.1** 安装源码与 `qwen --help`；安装 package.json 声明 0.21.14，但实际命令自报 0.23.1，启用判断使用命令自报版本。自动结构化接入锁定此版本，其他版本保持普通终端功能。

## 原生机制

Qwen 的 `--json-file` 在正常 TUI 外输出独立 JSONL，`--input-file <path>` 接收原生提交。无需另外启动 ACP/model 会话，不向 PTY 猜测粘贴和回车。

- `system/session_start`：`session_id`，`data.protocol_version=2`，版本与 cwd。
- `user`：用户内容文本，包含的是结构化流自己生成的 UUID。
- 协议列出 `result`，但已核对的实际 TUI 不逐轮发送该事件；不能用它恢复 idle。
- `control_request/can_use_tool`：权限请求。本适配仅报告等待，不替用户审批。
- 输入 `{ "type": "submit", "text": "..." }`：进入原有 TUI 的 `useMessageQueue.addMessage`，不改 composer 的草稿。

**重要限制**：原生输入没有 requestId 回执，`addMessage` 会 trim，队列可能与终端提交合并。结构化流 UUID 与 transcript UUID 不相等。因此不能将写入输入文件或 `user` 流事件单独当成持久接收证明；后端须限制单个在途、身份与输入 epoch，结合新 transcript UUID/精确正文佐证，不确定时禁止自动重发。发送正文有首尾空白时当前拒绝，避免静默改变请求。

## 实现边界

`packages/terminal-daemon/src/qwen-launch.ts` 安装在现有 daemon-local bin 中，与 Claude 共用一套 zsh PATH 安装，不修改用户 dotfiles/settings。

每次 Qwen 启动创建独立私有 input.jsonl；退出删除，不复用上次进程的命令文件。wrapper 每 100ms 读取至多 256 KiB 私有输出文件，将结构化元数据通过按终端实例授权的 Unix IPC `qwenEvent` 发送，消息串行并等待对应 reply。`--help`、ACP、用户自带输入/输出通道与非验证版本不注入适配。

`writeQwenCommand` 一次同步 append 一个有界 JSONL，拒绝 slash command、控制字符、首尾空白、超大正文、symlink/非普通文件。文件超过 4 MiB 后拒绝继续写入，避免无限累计；不会 truncate 仍被 CLI 读取的文件。

自动 transcript 定位使用已由原生协议确认的 session ID，在 `~/.qwen/projects/*/chats/<id>.jsonl` 内精确唯一匹配，目录数上限 10000。不存在/多候选不猜。启动时文件可能尚未生成，用户/完成事件继续尝试。自定义根可用 `ROOST_QWEN_PROJECTS_ROOT`。不会按 cwd 最近文件或 mtime 绑定。

## Transcript

Qwen JSONL 使用 `uuid/sessionId/parentUuid/type/message.parts`：正文 text、记录到文件的 thought、functionCall、functionResponse 分别映射消息、思考、工具调用、工具结果。用户的 `systemPayload.displayText` 优先，避免把 hook 附加上下文误当用户原文。

`packages/ai-transcript/src/qwen.ts` 提供读取/详情/精确 ID discovery；每次 256 KiB，单行 1 MiB，工具预览 4000 字符，详情 256 KiB；UTF-8 跨块、尾行、文件替换/截断、session mismatch 复用既有 checkpoint 语义。未知内容呈 partial，保留普通终端。

当前展示的是受支持的已记录条目；不宣称逐 token 流、分支 rewind 后的当前分支重建或完整所有多模态内容。系统元数据不展示，goal/system provenance 不冒充真人消息。

## 源码证据

本机自更新实际执行目录 `~/.qwen/updates/npm/d40fdc35d5298b66/versions/0.23.1/node_modules/@qwen-code/qwen-code/`（全局 cli-entry.js 自动转发；另核对过基础安装 0.21.14 的同名实现）：

- `chunks/chunk-LNCNUMJ5.js` / `chunks/startInteractiveUI-F5DKMLOV.js`：DualOutputBridge、RemoteInputWatcher、useMessageQueue（原生队列不修改草稿）。
- `chunks/chunk-3VWPPK5Q.js`：StreamJsonOutputAdapter.emitUserMessage 自行生成 UUID。
- `chunks/chunk-PDUMGZ2P.js`：ChatRecordingService.createBaseRecord/recordUserMessage/recordAssistantTurn/recordToolResult。
- 基础安装的 `chunks/chunk-BUQDLC2G.js`：Storage.getProjectDir，与 project sanitize 规则。

官方来源：[Qwen Code 仓库](https://github.com/QwenLM/qwen-code)、[Hooks 协议说明](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)。网页随版本更新；实际启用条件以已验证本机版本及原生 protocol_version 为准。

## 验证

- transcript 两项测试通过：正文/工具/原始用户文字、增量去重、identity mismatch、跨 UTF-8、bounded read、详情与未知内容降级。
- launcher 两项测试通过：真实 wrapper 子进程与模拟原生 JSONL 文件、IPC hello/reply 顺序、退出清理；输入格式与拒绝条件。
- 公共 owner 的 ledger / receipt / pause / concurrent input 由公共集成测试覆盖，不能以这些 fixture 冒充模型端联调通过。

## 本轮明确能力边界与下一步

**自动身份、正文与工具记录读取已实现；浏览器 GUI 发送仍明确不支持（`lifecycle_unavailable`），不是完成多轮适配。** 原生输入 transport 已有真实模型验证，但可靠生命周期尚缺：

1. `SessionStart` 时尚无 transcript，第一条用户消息落盘后才取得精确路径。
2. 实际 TUI 不发逐轮 `result`；`message_stop` / assistant.stop_reason=null 可在 thinking/text 分块、中间工具轮出现，不能冒充最终 Stop。
3. RemoteInputWatcher 只支持 `submit` 与 `confirmation_response`，没有查询 idle/status 的原生命令。此版本不能靠它补生命周期。
4. 系统 settings overlay 无效：registry 读取 getUserHooks/getProjectHooks/extensions，getUserHooks 直接取 user.settings.hooks，忽略合并后的系统 hooks。原生 `--extensions` 只选已注册扩展，没有临时 --plugin-dir。没有修改全局 hooks、auth、history。
5. 全局 cli-entry 启动实际 CLI 时 stdio:'inherit' 丢掉额外 fd3，所以实现改用私有 `--json-file`；这也是首次真实 probe 发现而 fixture 未覆盖的边界。

后续可靠路线：上游提供逐轮状态/临时 session hooks，或另行实现用户明确配置的 Qwen observer extension。只有已证明的同一 TUI 生命周期来源才允许 payload.lifecycleSupported=true；现有 wrapper 不发送该标志，不能仅按版本启用。

可复现真实探针：`ROOST_VERIFY_QWEN_SYNC=1 node --import tsx --test packages/terminal-daemon/tests/qwen-launch.test.ts`。只启动隔离 PTY、原生 input-file 提交一条无工具请求，确认同一 native session 的 transcript 有真实模型回复，清理测试进程和临时文件。测试会像正常 CLI 创建原生会话；清理只删除已确认为该次新建会话的 transcript，不删除其他历史，不重启日常 daemon。它证明单次原生 transport，不证明 GUI 多轮接收闭环。

2026-09-09 实测：上述 opt-in 命令 3/3 通过（真实模型路径约 4.08 秒）；默认运行 2 通过、1 跳过。reader 2/2 通过，daemon typecheck 通过。
