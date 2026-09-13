6 subagent 全回。结论：Warp 值得抄的是策略/状态机/边界语义，不值得抄的是整套框架（warpui                                          
 retained-mode、多前端泛型、Firebase/IAP、X11 seat、credential broker）。                                                          
                                                                                                                                   
 最高优先级（先做这 5）                                                                                                            
                                                                                                                                   
 1. 输出节流=前沿+尾部合并 16ms：warp/app/src/throttle.rs + warp_tui/terminal_session_view.rs:3351。首帧直写 +                     
    窗口内只留尾帧，replay/catchup 不参与合并。落点 frontend/src/terminal/sessionController.ts(onFrame) + connection.ts +          
    resume.ts + packages/terminal-protocol。成本 S，治 AI 流帧率抖。                                                               
 2. tool-call 有序截体：specs/tui-agent-tool-calls/TECH.md。messages 唯一排序源、派生不持久、有状态后按 ID key                     
    map；ToolCall{id,taskId,kind,status} 初版只渲染一行静默行。落点 packages/ai-session-bridge +                                   
    frontend/src/session-status/store.ts + SessionRow.tsx。成本 S，补我方无 tool 级折叠/重放锚点的缺口。                           
 3. IAP 熔断退避 + 握手分类：warp_server_client/src/iap.rs + graphql_helpers.rs +                                                  
    websocket/src/lib.rs。30s*2^n/上限5min/5次停，401/403 与挑战分流，WS 层故意不重连。落点 frontend/src/terminal/connection.ts +  
    heartbeat.ts + deploy/static-server.mjs + diagnostics.ts。成本 S，我方现在 400×2 cap5000无限重试，缺熔断。                     
 4. watcher 合并语义：crates/watcher/src/lib.rs。{added,modified,deleted,moved} + create+remove抵消、rename                        
    squash、RenameMode::Any 按 exists()判生死。落点 backend/src/fs.ts + server.ts + FilesView.tsx。成本 M，去掉手点刷新。          
 5. 命令面板零态：app/src/search/command_palette/view.rs + command_palette.rs + palette_styles.rs。固定推荐 3 + 最近 3 +           
    PRIORITIZED 置顶，250 上限。落点 frontend/src/components/CommandPalette.tsx + search.ts。成本 S。                              
                                                                                                                                   
 分片明细                                                                                                                          
                                                                                                                                   
 终端引擎（specs/tui-viewport + tui-output-redraw + terminal-manager-view-abstraction +                                            
 warp_terminal/model/grid/{grid_handler,resize,ansi_handler} + warp_tui/terminal_session_view + tui_block_list_viewport_source）： 
 - B2 TUI 帧原地语义：活跃 AI 会话 Clear/窄resize 走原地清不进 scrollback，finished 回退。落点 xtermEngine.ts + dec.ts +           
   terminal-runtime/processes.ts(replay) + terminal-daemon/owner.ts。M/中，治全屏重绘堆帧，需限定活跃 AI 防吞历史。                
 - B3 高度缓存+OVERHANG20 带区重测+量测/只读双路径：只量脏块，选择/快照走只读。落点 xtermEngine.ts + sessionController.ts +        
   replay.ts。M/低。                                                                                                               
 - B4 resize 所有权收敛：fit() 定序 term.fit→conn.fit(force)，cols/rows未变提前返回，daemon 幂等。落点                             
   sessionController/connection/xtermEngine fitExact。S/低。                                                                       
 - B5 PtyIntent 窄词汇小步版：input|resize|reopen|snapshot 意图通道，postWire 放链接/IME/wheel。S/低。勿引 Manager<S> 泛型。       
 - 不抄：多前端泛型装箱、termios 密码轮询、session-sharing 广播。                                                                  
                                                                                                                                   
 TUI 交互（specs/tui-{input-view,hoverable-hit-area,synthetic-mouse-replay,transcript-view} +                                      
 warp_tui/{editor_element,editor_interaction,clipboard,link} + warpui_core/runtime/{event_conversion,mod}）：                      
 - IME：Warp 反面教材（is_composing恒false 无 IME），肯定我方 terminal/ime.ts --ime-* pin 路线，继续做光标锚定。S。                
 - 滚轮固定步长×hit-test 门：我方 wheel.ts 已对，加像素累积器即可，别学固定 2 行。S。                                              
 - 链接 footprint + down-in/up-in配对 + 恒下划线hover加粗（link.rs）：对 fileLinks.ts + fileLinkBuffer + TermView onMouseUp。S。   
 - 粘贴整包单 action + 图片分类失败回原文：对 imagePaste.ts + sessionController。S。                                               
 - 快捷键和弦进 keymap/可打印进 element：对 keys.ts + xtermEngine。M/中。                                                          
 - 不抄：保留几何 Scene 重构、常驻 arboard Lease、REPORT_ALTERNATE+ALL_KEYS 全开。                                                 
                                                                                                                                   
 Agent UX（specs/tui-agent-tool-calls + x11-background-computer-use + agents/specs/APP-4907/4901/4902 + CODE-1890 +                
 ai/agent/action/mod.rs + ai/skills/read_skills.rs + ai/agent_management/notifications/toast_stack.rs）：                          
 - 起草期焦点保护：仅 Blocked 抢焦点，解决归还草稿。落点 SessionRow + bridge BridgeState.waiting拆drafting/blocked。S。            
 - per-conversation auto-approve：Respect⇄RunToCompletion 三入口同态 + warping 指示，默认 off。落点 session-status/store +         
   SessionRow + quietNotify。M/中。                                                                                                
 - 后台 owner 隔离 + end_background_session(owner)：落点 ai-session-bridge bind/unbind + quietNotify。M/中，先定 409 语义。        
 - 通知有界栈 cap3 + 100/500 字折叠：落点 quietNotify.ts + SessionRow。S。                                                         
 - 问答 Editing/Completed + 逐题 draft + 类型化 cancel：落点 bridge permission事件 + store waitingFor:question。M。                
 - 不抄：MPX/CGEvent 投递原语、cell-grid 渲染库、RequestFileEdits 半成品门控。                                                     
                                                                                                                                   
 工作区/文件（crates/watcher + command-signatures-v2/js + specs/warp-control-cli +                                                 
 app/src/{workspace/view/tab_grouping,workspace/tab_group,session_management,code/opened_files,projects} +                         
 zachlloyd/restore-fast-forward-state）：                                                                                          
 - generation-tagged 中断解析 + PendingScan 门闩：落点 FilesView + attachment-store/catalog + library。S。                         
 - pin/group 分离 + pinned 前缀不变量：group.pinned唯一真源。落点 workspace-store/{projects,sessions,database} +                   
   ProjectGroup/Sidebar。M/中。                                                                                                    
 - last_opened_ts + upsert + MRU/status优先排序：落点 workspace-store/sessions + Sidebar + CommandPalette。S。                     
 - 快照只存 ID + JSON 不透明 + toggle 即时写：落点 workspace-store/replay + sessions + history + server。S。                       
 - 稳定错误码 + opaque ID + stale 不换目标：落点 backend server/http + FilesView。S。                                              
 - OpenedFilesModel 按 repo keyed：落点 workspace-store + FilesView pendingSelect。S。                                             
 - 不抄：credential broker 整套、三源 MCP 订阅网、计费/团队模型。                                                                  
                                                                                                                                   
 实时链路（crates/{websocket,warp_web_event_bus,warp_server_client/base_client+auth/session+iap+graphql_helpers+network_logging,wa 
 rp_server_auth/credentials,warp_util/on_cancel}）：                                                                               
 - 有界诊断环 50 条 + 通道 100 + snapshot_text()：落点 diagnostics.ts + TerminalDiagnostics.tsx + terminalTransport.ts。S。        
 - Typed 错误 + actionable 位：纯前端派生函数。S。                                                                                 
 - 预刷新 5min buffer：以后有鉴权再做，现在零改动。                                                                                
 - 不抄：全局 warpEmitEvent 单例、graphql_ws_client、Firebase 全套。                                                               
                                                                                                                                   
 应用壳（app/src/{search/command_palette/view,palette_styles,command_palette,keyboard,appearance,settings/theme} +                 
 crates/settings/macros + warpui_extras/user_preferences/file_backed + script/run-tui + .config/nextest.toml）：                   
 - 瞬态主题预览不落盘：落点 theme.tsx + SettingsDialog。S。                                                                        
 - 设置错误两态 + 文案函数共用：落点 SettingsDialog + 后端设置加载。S。                                                            
 - 快捷键注册表（归一化/none哨兵/测试禁写）：落点 Shell.tsx keydown。M/中，需先定与 xterm 直通优先级。                             
 - 偏好写保护 + 读一次写时 flush：落点 workspace-store + Shell autoSaveId。S。                                                     
 - run-tui 三招（--分离/target-dir 定位/二进制旁暂存）：落点 scripts/。S。                                                         
 - nextest 分级：按需抄 retries/限流。S。                                                                                          
 - 不抄：warpui 整套、SyncToCloud 矩阵、bundled skills 流水线。                                                                    
                                                                                                                                   
 建议顺序：节流+熔断+诊断（终端）→ tool 截体+焦点保护+有界通知（Agent）→ watcher 合并+generation 门闩（文件）→                     
 零态+主题预览（壳）。                                           