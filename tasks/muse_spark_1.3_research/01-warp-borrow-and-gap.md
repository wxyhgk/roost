# 01 Warp 借鉴与当前差距

核验基线与验证限制见 [README](README.md)。以下 `Warp:` 路径均相对 `research/third-party/warp/`；我方路径相对项目根目录。行号用于定位本次快照，后续以符号为准。

结论：移动端操作和统一命令入口值得推进；终端恢复、文件监听、滚轮累积、偏好持久化已有基础。不能把 Warp 的块模型、认证重试、原生输入与我方 xterm/WebSocket 直接等同，也不能从单一机制推导产品整体强弱。

## 1. 终端渲染与 PTY

| 机制 | 实际证据与我方现状 | 判断与动作 |
| --- | --- | --- |
| 60Hz 节流 | Warp: `app/src/terminal/view.rs:617` 定义约16.667ms；`:3801` 与 `crates/warp_tui/src/terminal_session_view.rs:2288` 节流 wakeups_rx；`app/src/throttle.rs:27` 保留首事件并合并后续唤醒。我方 `frontend/src/terminal/resume.ts:createResume` 有异步顺序队列、256×1024个字符串代码单元的合批预算和快照屏障。 | Warp 合并的是重绘唤醒，不是 PTY 字节。删除“直接同步、缺16ms节流”的判断。先测解析、渲染和快照耗时，再决定是否增加定时合批；不得丢输出或让 applied 游标早于解析完成。 |
| AI CLI 主屏清屏语义 | Warp: `crates/warp_terminal/src/model/grid/grid_handler.rs:405` 的 FullGridClearBehavior、`ansi_handler.rs:853` 和 `resize.rs:65` 已有实现；GUI `app/src/terminal/view.rs:13669` 在匹配 CLI Started 时接线。我方 `frontend/src/terminal/connection.ts:203` 与 `sessionController.ts:206` 已传递 CLI 身份。 | 这不是仅存在于 spec 的方案，但依赖 Warp block 历史模型。不能凭 CLI 身份在 xterm 强制原地清屏，避免吞掉有效历史；finished 的 resize 分支也不能概括成“CLI 退出自动关闭模式”。 |
| 块高度缓存 | Warp: `crates/warp_tui/src/tui_block_list_viewport_source.rs:56,129,485,503` 包含 OVERHANG_ROWS=20、量测带区、dirty 缓存和 selection 只读路径。我方 `frontend/src/terminal/xtermEngine.ts:250` 是 SerializeAddon 序列化。 | 属于 TUI 富内容块虚拟列表，不是终端快照优化。删除“快照缺脏块缓存”的直接迁移任务。 |
| resize 顺序与去重 | 我方 `frontend/src/terminal/sessionController.ts:223,314` debounce 并先 term.fit 后 conn.fit；`xtermEngine.ts:45` 尺寸变化才 resize；`connection.ts:283` 已有 lastSize/force。 | 已有基础，不列重复改造。`packages/terminal-daemon/src/owner.ts:46` 转给 runtime，并非此处直接写 node-pty。 |
| 窄操作边界 | Warp: `app/src/terminal/writeable_pty/terminal_surface.rs:24` 已实现 PtyIntent，GUI/TUI 均有投影。我方 `packages/terminal-protocol/src/index.ts:42` 已有 ClientMessage。 | 保留现有协议边界；不因 Warp 有额外抽象就新增 postWire 或移植泛型框架。 |

表中短路径沿用同格内前一完整路径的目录。性能验证应包含连续输出、断线续传、解析未完成时快照、实例切换和中文宽字符；不能仅以写入调用次数下降证明体验改善。

## 2. TUI 输入与交互

- **IME：保留浏览器专用实现。** Warp: `crates/warpui_core/src/runtime/event_conversion.rs:112` 中 is_composing:false 是 Crossterm TUI 转换；GUI `crates/warpui/src/platform/mac/window.rs:1486` 会读取 composing_state。不能称整个 Warp 无 IME，更不能据此称我方全面超越 Warp。我方 `frontend/src/terminal/ime.ts` 仍需用浏览器中文输入场景验收。
- **滚轮：已有像素累积。** 我方 `frontend/src/terminal/wheel.ts:wheelTicks` 有行高换算、阻尼和跨事件 carry；`frontend/tests/terminal-mouse.test.ts` 有对应测试用例。删除“只差像素累积器”。
- **链接：已有按下/移动保护。** 我方 `frontend/src/terminal/xtermEngine.ts:86` 记录按下位置并抑制拖拽激活。进一步借鉴前，应明确是否存在同一链接身份、宽字符位置或拖动后的误开问题。
- **移动端：需要独立设计。** 终端选区、触屏滚动和拖拽、命令入口的方案见 [03](03-emacs-mobile-plan.md)。不移植原生剪贴板常驻机制、完整 Kitty flags 或 Warp 的场景框架。

## 3. 实时链路与诊断

| 项目 | 源码事实 | 剩余工作 |
| --- | --- | --- |
| 失败重试 | Warp: `crates/warp_server_client/src/iap.rs:17,447` 的30秒起步、5分钟封顶、5次失败上限，属于 IAP token 获取/刷新，不是终端 WS 重连。我方 `frontend/src/terminal/connection.ts:50,214,228,250` 已有400ms起步、5秒封顶、连续失败10次停止，恢复就绪和手动 restart 复位。 | 删除“无限重试”“新增8次熔断”“Warp重连更强”。不同失败原因是否需要不同重试策略，应作为独立需求评估。 |
| 异常关闭诊断 | 我方 connection 已记录 socket-close(code)、handshake-timeout、reconnect-gave-up(attempts)。`frontend/src/terminal/diagnostics.ts:createDiagnosticTrace` 保留40条；`backend/src/diagnostics.ts:createDiagnostics` 提供 daemon/AI 同步健康度。 | 可改善结构化字段和面板展示，但不是从零补诊断。浏览器未必可见 HTTP upgrade 拒绝的具体原因，需要服务端证据，不能只凭1006精确分类。 |
| 有界网络日志 | Warp: `crates/warp_server_client/src/network_logging.rs:11,16,47` 有50条缓存、100队列和 snapshot_text()。 | 借鉴有界性及可读导出，不机械复制数字；终端正文、输入和路径不应混入现有只记录运行元数据的诊断。 |
| heartbeat | 我方 `frontend/src/terminal/heartbeat.ts` 已有15秒探测、10秒超时、隐藏页暂停和休眠偏差处理。 | 保留，避免与重连重构重复建设。 |

## 4. Agent、工具展示与通知

**Warp 的动作模型分层实现。** `app/src/ai/agent/mod.rs:1042` 的 AIAgentAction 包含 id/task_id/action/requires_result；`app/src/ai/blocklist/action_model.rs:78` 维护 Preprocessing/Queued/Blocked/RunningAsync/Finished(result)，TUI 显示状态另见 `crates/warp_tui/src/tool_call_labels.rs:52`。原文的 ToolCall{id,taskId,kind,status} 只能当作我方候选设计，不能当成 Warp 原始类型。

我方 `packages/ai-session-bridge/src/index.ts:5,24,111` 已有事件去重、generation/seq、单事件序列化大小上限1MiB，以及默认4096条/8MiB保留窗口。它拒绝超大事件，不是静默截短 content。`frontend/src/session-status/store.ts` 已有 toolName/toolInputPreview 和阻塞摘要；缺的是一等 tool ID 和完整生命周期。下一步应先确认 CLI 来源能提供哪些稳定字段，再扩展只读事件契约、适配、存储、回放和展示，不能仅补一个 UI 类型。

**焦点和控制协议分开。** Warp `crates/warp_tui/src/agent_block.rs:961` 的 active_blocking_input_source 会确认队首 action 为 Blocked、由当前 block 渲染且子视图仍需确认。可借鉴“确实等待输入才提供焦点目标”，但我方只读面板尚无 draft 输入，不应提前复制草稿抢焦点逻辑。

我方 `frontend/src/api/aiSession.ts:5` 明确单向只读，`backend/src/ai-session-stream.ts:19` 拒绝入站控制消息。自动批准、取消运行都需要新的控制协议及 CLI 支持，移出小改动清单。Warp `crates/warp_tui/src/terminal_session_view.rs:3473` 的 pending-query autoexecute override 不能直接等同于批准所有工具权限；`crates/warp_tui/src/session.rs:215` 根据 CLI flag 选择 RunToCompletion 或 RespectUserSettings，不能笼统写“默认 off”。`crates/computer_use/src/lib.rs:130` 的 owner/end_background_session 是后台电脑控制资源清理，不能直接当作终端会话生命周期设计。

**通知需按用途比较。** Warp `app/src/ai/agent_management/notifications/toast_stack.rs:150` 最多同时2个 toast；同目录 `item.rs:144` 最多100条历史；`item_rendering.rs:32` 的100/500是折叠/展开字符数，三者不是同一队列。我方 `frontend/src/quietNotify.ts` 已有40/120字符限制、session tag 替换以及 pendingRef/blockedRef 的 ID 去重。可补关闭会话后的集合清理、连发聚合和声音节制；不要写成“无界消息队列，直接cap=3”。

## 5. 文件与工作区

详细许可及技术证据见 [02](02-file-tree-license.md)。

- **监听已接通。** 我方 `backend/src/watcher.ts:createFileWatcher` 递归监听、每根共享句柄，并在150ms窗口合并通知；`frontend/src/api/fileWatch.ts:watchFiles` 接 WS；`frontend/src/components/FilesView.tsx:614` 通过 rev 触发目录重拉。当前是树失效通知，不是逐路径增量 patch。
- **不能混淆补丁语义。** Warp `crates/repo_metadata/src/file_tree_store.rs:203,219` 先处理 remove_entries，再增补更新节点，不能仅凭 parent_path_to_replace 字段名理解为无条件覆盖整个子树。是否引入该复杂度，应由大目录刷新成本决定。
- **已有部分竞态保护。** 我方 `frontend/src/components/FilesView.tsx:904,929` 的目录/预览 effect 有 cancelled 保护；:1031 首次展开 toggle 异步路径没有同等代次保护，:1055 展开目录刷新 effect 仅依赖 rev。应针对快切目录、首次展开时切会话、收起后文件变更再展开写复现，再决定统一请求身份/缓存失效方案。
- **已有懒加载和排序。** `frontend/src/components/FilesView.tsx:1041` 首次展开才读取子目录；`backend/src/fs.ts:listDir` 已目录优先、localeCompare 和隐藏过滤。数字感知自然排序是可选差异，不重复建设已有能力。
- **置顶、分组展开状态已有持久化。** `packages/workspace-store/src/preferences.ts:39` 在 meta 中保存 expandedProjectIds/pinnedSessionIds，`frontend/src/App.tsx` 排序时排除置顶会话。不能从 sessions 表没有 pinned/collapsed 列推断功能缺失。最近打开 MRU 和服务端排序约束需按产品需求另行定义；当前最近输出排序不等于 MRU。
- stale/ambiguous 等错误语义仅在有实际消费方和恢复动作时扩展，不为对齐 Warp 名称新增错误码。

## 6. 应用壳

- **命令面板：已有零态，仍可扩展命令执行。** 我方 `frontend/src/components/CommandPalette.tsx:81` 空查询时优先 blocked、再按 lastOutputAt 排列前8个会话；不是持久化的最近打开。Warp `app/src/search/command_palette/view.rs:667` 与同目录 `zero_state/items.rs:11` 有最近选择及推荐动作。可借鉴命令注册、可用条件和发现入口。flat.indexOf(item) 当前使用共享对象引用，删除“同 id 多 kind 误判”的未经证实缺陷。
- **主题预览：可选增强。** Warp `app/src/appearance.rs:150,165` 有 transient theme；我方 `frontend/src/theme.tsx:65` 直接持久化。若实施预览，应定义取消恢复与确认保存，不能只延迟 localStorage 写入。
- **布局已有持久化。** 我方 `frontend/src/components/Shell.tsx:129` 有 autoSaveId；没有坏值复现前，不列为已确认缺陷。移动布局与桌面布局的恢复边界见03。
- 脚本参数透传、完整快捷键和弦、多前端泛型、云同步/计费均不因 Warp 存在而自动成为本项目任务。

## 7. 建议实施顺序与验收

| 顺序 | 范围 | 完成标准 |
| --- | --- | --- |
| 1 | 触屏目标、hover依赖、滚动与拖拽冲突 | 手机上能滚动会话列表，操作按钮可触及，滚动不误排序；桌面拖拽保留。 |
| 2 | 终端选区与复制 | 中英文、宽字符、历史滚动和键盘弹出均有明确行为，必须真机验收。 |
| 3 | 统一命令入口、分层取消 | 建/切会话、开文件有触屏入口；取消弹层不误发CLI中断，不吞终端正常快捷键。 |
| 4 | 剪贴历史与通知整理 | 明确复制才收录，超长内容不静默截断；通知去重、聚合、关闭清理可验证。 |
| 5 | 文件请求身份/缓存边界、只读工具生命周期 | 先完成具体复现或上游字段核验，再实施相应数据契约与回放测试。 |
| 按证据安排 | 性能、关闭分类、主题预览、MRU | 性能有前后测量；诊断可解释真实故障；预览/MRU有明确产品需求。 |

现有验收入口包括 `frontend/tests/terminal-client.test.ts`、`frontend/tests/terminal-mouse.test.ts`、`frontend/tests/ai-session.test.ts`，以及 `backend/tests/watcher.test.ts`、`backend/tests/file-watch-route.test.ts`。本轮只检查源码与文档引用，未执行这些测试，不把已有测试文件当成实测通过证明。
