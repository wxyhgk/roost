# 前端耦合审计

日期：2026-09-07。对象：当前工作树，包含未提交的资料库、弹窗、主题及终端改动。由三个 subagent 分别审计依赖图、资料库与面板、终端领域，主代理补查文件管理和 WorkspaceProvider。

本次为静态代码审计；除本记录外未改文件，没有操作用户资料或运行服务。具体控制流结论与待复现的时序/性能风险分开标注。

## 总体判断

**静态依赖中等、结构较清楚；状态与生命周期耦合中等偏高。** 不需要全盘重写，但继续直接在组件和共享单例里追加功能，会增加跨功能回归风险。

- 子代理使用本地 TypeScript AST 扫描 72 个 TS/TSX 文件、170 条静态本地 import/export 边。包含类型和排除类型的图均未发现循环。这不包括事件、共享状态、DOM 和异步完成顺序形成的依赖。
- 实际运行 `node scripts/check-boundaries.mjs` 通过，未发现前端直接导入后端 SQLite/runtime 实现。
- 检查器把整个 frontend 当一个边界，不检查前端内部领域层次和循环；不能用这个通过结果证明所有内部边界都健康。
- FilesView 为 1099 行，Workspace store 为 385 行。行数只用于定位职责集中，不作为风险等级的直接依据。

| 区域 | 判断 | 主要原因 |
| --- | --- | --- |
| 前后端、workspace 包边界 | 较清楚 | 浏览器侧使用协议和 CLI adapter，未穿透 Node 存储/运行时 |
| connection / resume / appearance | 较清楚 | 无 React 的连接模块、窄 Sink、可注入测试依赖 |
| 资料库状态通知和详情缓存 | 偏高 | 单条保存使所有列表失效；所有已访问正文参与聚焦刷新 |
| 面板导航与弹窗宿主 | 偏高 | toggle/show 语义混用、双步骤导航、手动 DOM 与 React 生命周期交叉 |
| 终端生命周期与共享句柄 | 偏高 | 异步注册、裸 Map、ready 状态跨三层交接 |
| 文件管理与 WorkspaceProvider | 中等偏高 | 文件打开策略分散，工作区一个 Context 承载全部状态与动作 |

## 优先处理的具体问题

### P1：单条自动保存重置所有资料列表

证据：`frontend/src/library/client.ts:21,123` 共用 listVersion，保存成功 emit(true)；`frontend/src/library/hooks.ts:18-23` 监听该版本后清空 items/cursor、请求第一页；`frontend/src/components/CommandPalette.tsx:30-31` 的笔记与片段列表使用同一机制。

代码可直接推出：加载第二页后编辑一条资料，自动保存会丢弃已加载分页；无关资源列表也会重查。这是“条目改变”与“重置所有查询”被绑定。

建议：按资源/条目区分通知，更新受影响摘要；后台重查保留已加载范围和滚动位置，搜索变化才清空列表。先补“已加载两页→保存→列表仍完整”的 hook/组件集成测试。

### P1：导航与折叠共用一个动作

证据：`frontend/src/components/Shell.tsx:35-41` 的 selectRight 对当前已展开视图执行折叠；`:133` 又将其传给命令面板 onShowView；`frontend/src/components/CommandPalette.tsx:119-124` 跳到笔记/片段时先调用它再 publishNav。

代码可直接推出：笔记栏已打开时，从命令面板选择另一条笔记，会折叠目标面板。不是应当减少所有导航依赖，而是两个入口的动作语义不一致。

建议：区分 toggleRightView 与 showRightView；命令面板使用 show。随后提供一次性的 openFile/openLibraryItem，让调用者不必复制“展开面板→投递目标”的顺序。

### P1：终端句柄注册时间与选区订阅隐式绑定

证据：`frontend/src/terminal/handles.ts:5` 暴露可写 Map；`frontend/src/terminal/useTerminal.ts:140,157` 等待尺寸后注册；`frontend/src/components/SelectionSaveBar.tsx:19-25` 的 effect 只在 sessionId 改变时取一次句柄。

异步挂载时，消费者先运行即可错过订阅，Map 后续写入不会通知它。鼠标即时读取仍可工作，因此不能据此声称整个选区保存不可用；本轮未运行浏览器复现此症状。

建议：注册表提供可订阅的句柄生命周期，或由 useTerminal 直接返回选区能力；取消业务组件对可变 Map 的读写。补“先订阅→句柄晚到→句柄替换→注销”的测试。

### P1：发送结果的成功语义不可靠

证据：`frontend/src/terminal/handles.ts:18-22` 只要找到回调就返回 true；`frontend/src/terminal/connection.ts:62-75` 在 dead/尚无实例时可直接丢弃输入，重连时可能排队；`frontend/src/components/NotesView.tsx:102` 据返回值显示已发送。文件路径插入也使用同一接口。

建议返回 sent/queued/rejected 及原因，UI 对应显示；sent 仅表示已交给连接层，不能代表 CLI 已执行。此为当前代码分支能证明的契约不一致，不需要大重构才能修。

### P1：文件打开入口没有统一未保存保护

证据：`frontend/src/components/FilesView.tsx:720-723` 的点击选择会检查 previewDirty；`:691-717` 的终端链接和命令面板入口则直接清 dirty 并修改 selected；`:238-249` 在 selected 改变时清理编辑状态。

静态路径显示保护策略随入口不同，有丢弃未保存编辑的风险；本轮未实际操作用户文件验证。

建议：所有来源统一经过 requestOpenFile，由同一编辑会话控制器决定是否允许切换。不要只把 1099 行文件机械拆成多个文件，却保留三套不一致的打开策略。

## 第二阶段的结构问题

### 资料库运行时与视图知道过多内部细节

`frontend/src/library/client.ts:190` 起导入时创建单例、清理旧数据、访问浏览器存储并安装全局事件；`library/hooks.ts:4` 订阅全局 version。NotesView 直接遍历 drafts，LibraryRecovery 直接 emit(true) 并在渲染时扫描存储。

逐字符编辑会通知所有订阅者；恢复组件的扫描成本也被绑定到输入频率。当前没有性能测量，不宣称已经卡顿。建议保留可注入的 LibraryClient 核心，把启动/清理移到显式 runtime，提供 useDraft、useBackups 和只读选择接口。

用户已明确要求删除旧资料，应保留该产品决定；调整的是删除动作的启动位置，不恢复迁移系统。

### 已保存详情与未保存草稿共用无限增长集合

`library/client.ts:67-68` 打开正文加入 drafts，`:187` refreshAll 刷新所有已打开过的记录；已保存条目没有容量淘汰。回到窗口时的请求数随历史浏览量增长，而非当前可见量。

建议分离详情缓存和必须保存的草稿，缓存有上限，刷新聚焦条目与可见列表；合并 focus/visibility 触发，限制并发。不能淘汰未保存草稿。

### 弹窗宿主与 React、焦点、快捷键相互绑定

`components/RightPanel.tsx:23-44` 手工创建、移动、清除 portal 宿主，同时管理原生 dialog 和焦点；通过中文 placeholder 寻找搜索框，并知道 Shell 的快捷键。

保持同一 portal target 可保留编辑器，是合理需求。之前顶部空白缺陷已修复，不是本轮仍未修复的问题；它说明手动宿主的所有权需要封装和集成验证。

建议抽取专门的展示宿主，使用显式 focus ref，保留同一个编辑器。验证 notes→展开→收起→files→snippets→Esc，检查空宿主、选择、草稿与焦点。

### 终端握手完成凭据未跨越完整异步链

`terminal/connection.ts:45,51-52` 有 socket generation，但 `terminal/useTerminal.ts:121-125` 等待 resume.done 后只校验 cancelled/dead，再对当前 conn 调用 markInputReady；后者 `connection.ts:193-198` 未检查原完成回调所属代际。

旧连接解析未完成就重连时，可能过早打开新连接的 ready。此为待组合测试验证的时序风险，不当作已复现故障。建议 ready 凭据携带 connection generation/instance，并由连接控制器验证；补“慢解析→断线→新 hello→旧 done”测试。

### useTerminal 与 WorkspaceProvider 的协调责任集中

`terminal/useTerminal.ts:69-268` 的一个 effect 管理引擎、连接、重放、缓存、图片、注册、resize、重启。建议先加接缝测试，再提取不依赖 React 的会话控制器，保留已分开的 connection/resume/appearance。

`store.ts:259-293` 管理初始化、轮询、持久化；`:295-375` 的一个 Context value 含全部状态和动作且随 state 重新生成。任一状态变动会通知所有消费者，失败回滚又通过 `store/sync.ts` 全量 hydrate。这里是失效范围和责任集中问题，不是已测量的性能故障。建议先提供选择器/稳定动作接口，再按实际变更频率拆分会话实时状态与工作区设置。

## 加载与扩展边界

- `terminal/index.ts:1` 静态连到 xtermEngine，同时导出发送、状态等轻量能力。拆轻量 public/commands/status 入口，挂载引擎独立；这不是“tree-shaking 一定失效”的证明。
- `components/FilesView.tsx:26-36` 静态装配 XYZ 等预览；`editor/xyz.tsx:2-3` 加载 3Dmol 与初始化副作用。建议特殊格式实际打开时再加载插件，保留轻量匹配信息。
- `TerminalPane.tsx:76` 与 `useTerminal.ts:295` 查询 xterm/textarea DOM，应收回 adapter。adapter 内集中兼容私有 xterm API 的方向可保留。
- `terminal/fileLinks.ts:85-103` 事件只有 path/line，FilesView 用当前 cwd 解析。单终端当前布局通常成立，多终端/分屏需补来源 sessionId，避免由引擎直接读取 workspace store。
- `navigate.ts:11-18` 的全局监听与单 pending 槽适合目前一个查看器，但不能自动推广到多查看器。首先统一打开命令，无需马上引入路由框架。
- 视图类型来自具体组件的类型方向可后续整理；属于低优先级，不制造运行时循环。

## 保留的合理边界与实施顺序

LibraryClient 的 Transport/Storage 可注入，保存算法位于 React 外；library 内部没有依赖 terminal/editor/store/UI。connection 不依赖 React/xterm，resume 面向窄 Sink，已有领域测试。这些边界值得保留。

Shell 组装多个面板、命令面板搜索多个领域是正常职责。主题与重放必须协调，防止历史查询产生重复应答。隐藏终端保持挂载是维持会话的产品选择，不应为降低依赖擅自销毁。

建议分小步实施：

1. 修正导航 show/toggle、资料列表失效范围、终端输入结果与选区订阅、统一文件未保存检查。
2. 增加导航、分页保存、portal 切换、终端慢解析重连的集成测试；现有纯领域测试无法覆盖这些接缝。
3. 再收窄全局订阅、缓存刷新和运行时启动责任，提取终端会话控制器与弹窗宿主。
4. 最后拆轻重加载入口、按需加载预览插件，并给 frontend 内部增加少量可执行的依赖规则。

不建议先换框架、换状态库、批量改目录，或追求没有业务意义的零依赖。

## 实施进度

2026-09-07：已完成首轮接缝修复与模块拆分，详见 [实施记录](20260907-frontend-decoupling-implementation.md)。本文代码行号对应调研时快照；当前实现及验证结果以实施记录为准。

2026-09-07 第二轮：已收窄工作区字段订阅、单条资料与恢复备份订阅，并加入前端内部依赖检查，详见 [第二轮实施记录](20260907-frontend-decoupling-round2.md)。

2026-09-07 第三轮：终端会话控制器、注册所有权、文件链接来源隔离与长时间隐藏保护已实施，详见 [第三轮记录](20260907-frontend-decoupling-round3.md)。用户偶发空白的原始现场尚未复现，不将保护性修复等同于唯一根因已确认。
