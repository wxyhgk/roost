# 终端与 CLI 内置主题不同步：调研与处理方案

- 日期：2026-09-07
- 状态：终端适配与可读性兜底已实施；OMP 真机往返已验证；Codex 保留实时主题支持限制
- 范围：工作台主题切换后，Codex、OMP 等 CLI 的输入框、消息块和文字仍使用旧配色
- 调研分工：CLI 实现、成熟终端方案、终端协议与应用适配，三个子代理并行；主代理核对当前项目并汇总
- 代码基线：`bb5dddb513edffffffba9731df71c259e6f02728`

## 用户反馈与问题边界

工作台已经切换成黑白主题，但 CLI 自己绘制的输入框没有同步变化。用户截图中，黑色终端上出现浅灰输入区，同时文字也是浅色，导致内容难以辨认。

截图来源：`/Users/you/Library/Application Support/Index/originals/f57ba1d50c33fe130910e8650eb64ee8490617dbea45931f7f8f254ae32dab5d.png`。这里只记录原始路径，没有复制个人截图到仓库。

这个问题并非 xterm.js 独有。需要分别验证：

1. **可读性**：终端能否保证实际单元格的文字与背景有足够对比度？
2. **主题同步**：CLI 是否知道终端换了主题，并重新计算自己的颜色？
3. **历史内容**：已经输出到 scrollback 的显式 RGB 颜色是否仍然沿用旧值？

截图本身不足以确定 CLI 在何时选错主题，或确认用户当时运行的具体 CLI 版本。不能把“截图符合旧颜色缓存现象”写成已完成根因复现。

## 实施前项目状态（历史记录）

| 位置 | 当前行为 | 意义 |
| --- | --- | --- |
| `frontend/src/theme.tsx:34` | 从 CSS 读取默认背景、前景、光标和选区颜色 | 没有把 CLI 内部主题纳入同一配置模型，也没有提供完整 ANSI 16 色方案 |
| `frontend/src/terminal/useTerminal.ts:264` | 主题变化时调用 `setTheme()` | 前端已具备主题更新入口 |
| `frontend/src/terminal/xtermEngine.ts:179` | 仅执行 `term.options.theme = next` | 默认色变化不等价于 CLI 重新渲染 |
| `frontend/src/terminal/xtermEngine.ts:57` | 未显式配置 `minimumContrastRatio` | 安装版本默认值为 `1`，没有启用文字对比度补偿 |
| `packages/terminal-runtime/src/index.ts:42` | 设置 `TERM=xterm-256color`、`COLORTERM=truecolor` | CLI 可以输出显式 RGB，不能指望只修改 ANSI 调色板覆盖它们 |
| 本地依赖 | `@xterm/xterm=6.0.0`、`@xterm/addon-webgl=0.19.0` | 必须按实际安装版本核对能力，不能直接套用上游 master 的 API |

本地 xterm 6.0.0 的 `InputHandler.ts` 已注册 OSC 10/11 查询处理器；因此不能说当前完全没有颜色查询支持。当前安装源码未检出 Mode 2031 / 996 / 997 的处理或 `colorSchemeQuery` API。`onData` 已接到 WebSocket 输入通道，但查询回复的时序、重放期间的行为还没有端到端验证。

初次调研只新增本文；后续用户已授权实施。工作区原有的 `resume.ts` 与两个回放测试修改属于此前刷屏修复，在本次实施中保留。

## 后续验证必须区分的结果

- 仅保证文字可读，不能宣称 CLI 已同步主题。
- 上游 master 有代码，不能宣称本项目安装版本或 npm stable 已包含。
- issue 中的用户测量与解决建议，不等于维护者确认或合并发布。
- 新启动 CLI 能识别颜色，不等于运行中的 CLI 能实时响应变化。
- 当前输入区重画成功，不等于所有历史 RGB 输出都已重着色。

## 别人的具体处理：终端侧

| 产品 | 实际方案与配置 | 已核实范围 | 不能解决什么 |
| --- | --- | --- | --- |
| VS Code | `terminal.integrated.minimumContrastRatio` 默认 `4.5`，调整文字亮度；设 `1` 关闭。`workbench.colorCustomizations` 可单独配置终端色 | 当前正式文档 | 可能损失部分饱和度；不会替 CLI 更换输入框背景或选择主题 |
| xterm.js | `minimumContrastRatio` 提供同类字色补偿，`theme` 可配置默认色及 ANSI 色 | 本地 6.0.0 与官方 API：库默认 `1`，需要集成方主动开启 | 使用 xterm 不代表自动拥有 VS Code 的对比度策略 |
| iTerm2 | Profiles → Colors → Minimum Contrast；profile 可启用 separate light/dark colors | 正式文档；未核实对比度滑块默认数值 | 文档明确只调整文字、不改背景；滑块 `100` 不是 100:1 对比度 |
| Ghostty | `minimum-contrast`；`theme = light:Rose Pine Dawn,dark:Rose Pine` 按明暗选择配色 | v1.2.3 标签源码默认对比度 `1`；配置文档建议 `1.1` 避免完全隐形、`3` 以上改善难读 | 建议值不等于默认值；不适用于 Emoji、图片；仍需 CLI 响应主题变化 |
| WezTerm | `text_min_contrast_ratio = 4.5`；Lua 可通过 `wezterm.gui.get_appearance()` 选择配色 | 对比度选项文档明确标为 **Nightly Builds Only**，默认 `nil` | 不应当作所有稳定版都有；完全相同的前景背景保留为有意隐藏，目标比例不保证总能达到 |

来源：[VS Code](https://code.visualstudio.com/docs/terminal/appearance#_minimum-contrast-ratio)、[xterm minimumContrastRatio](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#minimumcontrastratio)、[xterm ITheme](https://xtermjs.org/docs/api/terminal/interfaces/itheme/)、[iTerm2 profile colors](https://iterm2.com/documentation-preferences-profiles-colors.html)、[Ghostty 配置](https://ghostty.org/docs/config/reference#minimum-contrast)、[Ghostty v1.2.3 默认值源码](https://github.com/ghostty-org/ghostty/blob/v1.2.3/src/config/Config.zig#L639-L650)、[WezTerm 对比度](https://wezterm.org/config/lua/config/text_min_contrast_ratio.html)、[WezTerm appearance](https://wezterm.org/config/lua/wezterm.gui/get_appearance.html)。

**独立终端配色也是已有设计。** iTerm2 的 Appearance → Theme 影响终端内容之外的外壳，终端内容配色在 profile 中配置。工作台可以借鉴这种分离；“跟随工作台 / 固定深色 / 固定浅色”是本项目建议，不是声称 iTerm2 菜单原文如此。[iTerm2 Appearance](https://iterm2.com/documentation-preferences-appearance.html)

**主题通知存在已发行实现。** Ghostty 1.0.1 发布说明明确调整了 Mode 2031 行为：OSC 10/11/12 不再触发其通知，以符合更新后的规范。不能将所有颜色操作都当作用户更换主题来广播，否则有机会形成反馈循环。[Ghostty 1.0.1](https://ghostty.org/docs/install/release-notes/1-0-1)

## 标准同步闭环与已有应用实现

### 颜色为何不会自然跟随

默认色、索引色与直接 RGB 是不同语义。例如 `SGR 48;2;R;G;B` 直接指定单元格背景；修改默认背景或 ANSI 16 色不会改变该 RGB 指令的含义。输入框若用了显式 RGB，需要 CLI 重画，或者终端额外采取颜色修改策略。[XTerm 控制序列，SGR 与 OSC](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

### 协议消息

下面 `CSI` 表示 `ESC [`，`ST` 表示 `ESC \`。

| 方向 | 消息 | 用途 |
| --- | --- | --- |
| CLI → 终端 | `OSC 10 ; ? ST` / `OSC 11 ; ? ST` | 查询默认前景/背景真实颜色 |
| CLI → 终端 | `CSI ? 2031 $ p` | DECRQM 查询是否支持主题通知及当前开关状态 |
| 终端 → CLI | `CSI ? 2031 ; Pm $ y` | `0` 未识别、`1` 已开启、`2` 已关闭、`3/4` 永久开启/关闭 |
| CLI → 终端 | `CSI ? 2031 h` / `CSI ? 2031 l` | 订阅/取消通知 |
| CLI → 终端 | `CSI ? 996 n` | 按需查询当前明暗 |
| 终端 → CLI | `CSI ? 997 ; 1 n` / `CSI ? 997 ; 2 n` | 报告深色/浅色；既可应答查询，也可通知已订阅程序 |

OSC 还可能以 BEL 结束，RGB 回复可能使用不同分量宽度，解析时不能只接受一种样本。通知必须通过 PTY **输入方向**交给 CLI；调用 `terminal.write()` 把它作为终端输出解析，并不能让 CLI 得知变化。收到通知后，应用可重新查询 OSC 11，再切换内部主题并重画。[Contour 协议](https://contour-terminal.org/vt-extensions/color-palette-update-notifications/)、[XTerm DECRQM/OSC](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

### Neovim 的实现

本次检查的是上游 `master`，不是对某个已安装版本的声明：

1. 启动时探测 `kTermModeThemeUpdates`，支持且未开启时订阅。
2. 收到 `997` 后，用 **100ms 定时器合并通知**，重新查询 OSC 11，而非直接用操作系统明暗替代真实背景颜色。
3. 按 RGB 背景亮度更新 `background`；用户手动指定 `background` 后停止自动覆盖。
4. 恢复前台时再查询，退出前取消订阅，避免遗漏更新与迟到回复。
5. 初次查询附带设备状态查询，避免对不支持 OSC 11 的终端无限等待。多个 UI 共用全局背景有最后应答者影响结果的限制。

源码：[tui.c](https://github.com/neovim/neovim/blob/master/src/nvim/tui/tui.c)、[input.c](https://github.com/neovim/neovim/blob/master/src/nvim/tui/input.c)、[defaults.lua](https://github.com/neovim/neovim/blob/master/runtime/lua/vim/_core/defaults.lua)。

### tmux 的实现

本次检查的是上游 `master`：外层终端查询与 pane 内应用状态由 tmux 分别维护，并非简单透传。

- 对外部终端开启 `2031` 并请求 `996`。
- 为 pane 内程序实现能力查询和订阅，维护 `MODE_THEME_UPDATES`。
- 在 popup/overlay 普通按键处理之前消费外部 `997` 报告。
- 只向已经订阅的 pane 发更新，并检查主题是否变化。
- 多个客户端主题冲突或无法得知明暗时，退回 pane 背景色推断。

源码：[tty.c](https://github.com/tmux/tmux/blob/master/tty.c)、[input.c](https://github.com/tmux/tmux/blob/master/input.c)、[server-client.c](https://github.com/tmux/tmux/blob/master/server-client.c)、[window.c](https://github.com/tmux/tmux/blob/master/window.c)。

## Codex 与 OMP：不能假定能力相同

### OMP：已发布标签中有完整实现

检查 `v18.1.11` 标签源码得到的调用链：

1. 先安装 stdin 响应解析器，再查询 OSC 11；紧接 DA1 作为查询结束标记。如果 DA1 已返回但没有 OSC 11，则结束本轮等待。
2. 开启 2031 订阅并查询支持状态；接收 `997` 后 **100ms 合并**，重新查询 OSC 11。
3. 重组分片 CSI/OSC；解析 1–4 位十六进制 RGB 分量，用 `0.299R + 0.587G + 0.114B` 与 `0.5` 比较推断明暗。
4. 去重后触发 appearance callback；theme 层选择 `theme.dark` / `theme.light`，自动变化按临时主题事件处理。
5. 停止时取消 2031 订阅并清理计时器与监听。

来源：[v18.1.11 terminal.ts](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/tui/src/terminal.ts)、[v18.1.11 theme.ts](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/modes/theme/theme.ts)、[官方主题文档](https://github.com/can1357/oh-my-pi/blob/main/docs/theme.md)。本次此前本机 `omp --version` 返回 `18.1.11`；版本号对应不等于我们已经在真实会话中验证了上述路径。

**它还为不完整终端链路做了降级：**

- 提供 `refreshAppearance()`；tmux 下显式刷新会先通过 passthrough 查询外层，让 tmux 更新缓存，再查询 tmux 缓存。
- 针对缺少 2031 的部分 macOS 环境使用系统 appearance 作为临时回退，同时有限次数重查 OSC 11，以终端实际颜色收敛。
- Windows Terminal 且不支持 2031 时有专门轮询路径。不能据此推导所有平台都应该持续轮询。

这些机制可在上述标签源码中核对。工作台自己的主题不一定等于 macOS 系统主题，因此不能简单发送系统明暗代替工作台终端颜色。

**避免主题修复重新引起刷屏：** OMP CHANGELOG 记录 17.2.0（2026-07-30）修复 direct WezTerm/macOS 无 2031 时的自动切换；17.2.2（2026-07-31）修复自动 appearance 变化清空原生 scrollback、打断阅读的问题。主题同步的验收要同时检查历史和滚动位置。[OMP CHANGELOG](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)

### Codex：同类问题存在，公开诉求不能当作已发布修复

| 记录 | 实际证据 | 状态与边界 |
| --- | --- | --- |
| [#18942](https://github.com/openai/codex/issues/18942) | 用户报告 0.122.0、Ghostty + tmux 下系统转浅色后输入框仍深色，退出重开恢复 | 本次查询为 Open；证明不局限于浏览器终端 |
| [#35559](https://github.com/openai/codex/issues/35559) | 用户报告 0.145.0、VS Code/WSL 下深色环境出现浅色输入区 | Open；去背景或加边框是作者诉求，不是已验证修复 |
| [#38575](https://github.com/openai/codex/issues/38575) | 针对 0.147.0 请求订阅 DECSET 2031；作者称启动后 focus/resize 不重新查询颜色 | Open；用户测量与提案，不是已实现支持 |
| [#19153](https://github.com/openai/codex/issues/19153) | 作者在 fork 提议 FocusGained 后重算配色，并称未创建 upstream PR | 虽为 Closed，不能据此认定已合并或发布 |
| [#33037](https://github.com/openai/codex/issues/33037) | 记录 focus 重查与输入读取争抢造成卡死，提出暂停读取、有限探测再恢复 | 是实现风险与方案记录，不当作已合并修复 |

调研时 `main` 的 `terminal_palette.rs` 有 `Cache { attempted, value }`；首次查询完成后缓存结果，甚至 `None` 也标为已尝试。这个文件与一次性查询现象相符，但只检查该文件，不能断言整个项目绝对没有其他刷新入口。[Codex terminal_palette.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/terminal_palette.rs)

调研阶段本机 `codex --version` 返回 `0.153.4`。上述 issue 分别涉及更早版本，当时尚需隔离实测；后续实测结果见下方“真实验证”。不应以“换成支持 2031 的终端”承诺 Codex 输入框一定实时换色。

### xterm 上游与安装版也要区分

调研时上游 `master` 类型定义已经出现 `vtExtensions.colorSchemeQuery`，描述了 `996` 查询与 `2031` 订阅通知；本项目安装的 6.0.0 没有该项。后续应核实包含实现的发行版、配套 addon 兼容性，再决定升级或适配；本次没有确认 npm stable 已包含，不能据此直接升级到未验证版本。[上游类型定义](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts)

## 实施规划（以下保留原调研建议）

1. **建立可重复观测**：分别启动本机 Codex 与 OMP 的隔离测试会话，记录主题查询、订阅、通知、回复与重画；覆盖深→浅→深。只记录协议元数据，避免收集提示词、历史正文或凭据。先证明启动查询与运行时切换各自发生了什么。
2. **启用可读性兜底**：评估 `minimumContrastRatio: 4.5`，用截图中的浅底浅字、深底深字、反色、dim、彩色 diff 和选区验证实际效果。提供关闭或调整的配置。该措施不保证输入框背景跟随主题。
3. **补齐标准同步链路**：先比较已发布 xterm 版本与上游实现；选择兼容升级或小范围适配。必须同时实现能力探测、按需查询、订阅/取消、通知和生命周期，不能只在主题切换时向 PTY 无条件塞一段转义序列。
4. **处理不配合的 CLI**：支持终端独立选择“跟随工作台 / 深色 / 浅色”，让用户能维持 CLI 启动时的配色组合。必要时提示用户在合适时机退出并恢复会话；不自动杀进程，不自动向 CLI 输入 `/theme` 或其他命令。

### 我们的架构需要额外验证

- **重放与快照**：历史里可能包含查询和订阅序列。回放不能把旧查询产生的回复当成用户输入，订阅状态也不能在恢复快照后悄悄丢失。
- **断连期间切换主题**：CLI 仍运行但浏览器不在线时，需要定义重新连接后的颜色对齐时机；单纯等待下一次按钮点击不够。
- **同一 PTY 的多个浏览器视图**：如果各视图颜色不同、同时回答 OSC 查询，一个 CLI 无法为同一条原始 RGB 输出分别选择两套主题。应先定义颜色报告的主视图或会话级主题归属，再做广播通知。
- **刷新成本**：通知合并去重，避免颜色查询→状态更新→再次通知的循环。不能为修主题重新引入全量历史回放、滚动位置跳变或输出队列积压。
- **颜色层级**：默认色、ANSI 索引色、显式 RGB 分别处理。不要用全局字符串替换重写 ANSI 字节流或直接修改所有浅色背景；这会破坏 diff、选择状态和应用自身的颜色语义。

## 实施验收清单

- [x] 记录版本：OMP 18.1.11、Codex 0.153.4、xterm 6.0.0、WebGL addon 0.19.0。
- [x] 实际颜色查询回复已检查；保留原生 OSC 设置、堆叠查询和 RGB 格式处理。
- [x] 2031 探测、996 查询、订阅/取消、30ms 通知合并有测试。
- [x] 未订阅不主动报告；只由网关选出的主连接回送颜色回复。
- [x] 自动通知不依赖伪造焦点、resize 或重播历史。
- [x] OMP 深→浅→深、输入草稿保持和协议往返完成浏览器验证。
- [x] Codex 单独观察启动查询与切换；未观察到订阅或切换后重查，不宣称实时同步。
- [x] WebGL 与 DOM 回退均验证浅底浅字、深底深字、反色、dim 与彩色样例。
- [x] 单元测试覆盖重放抑制旧查询、订阅快照/重置、重连报告；网关测试覆盖主连接移交。
- [ ] 大型真实历史、跨设备多视图、所有连接同时关闭再恢复的完整浏览器矩阵尚未穷尽。
- [x] 不对历史 RGB 做全局替换；只改善渲染可读性，保留 CLI 原始输出。

## 2026-09-07 实施与验证结果

### 已实施

- `frontend/src/terminal/appearance.ts`：Mode 2031/996 适配、30ms 去抖、ready/owner/replay 状态；使用 xterm 自己生成的 OSC 10/11/12 回复，统一走主连接通道，兼容 OSC 改色与堆叠查询。
- `frontend/src/terminal/xtermEngine.ts`：默认 `minimumContrastRatio=4.5`；主题订阅序列加入快照；重置时清理，销毁时取消定时器和解析器监听。
- `frontend/src/theme.tsx` 与配色面板：跟随工作台/固定深色/固定浅色，对比度可关闭；浏览器本地持久化，并通过 storage 事件同步同源页面。
- `packages/terminal-protocol`、`connection.ts`、`backend/src/server.ts`：新增 `appearance-owner` / `appearance-response`。同一网关中每个 PTY 的第一个连接为主连接，关闭后移交；回复携带实例 ID，非主连接及旧实例不写入 PTY。原有第一帧仍是 `hello`。
- 保留 xterm 6.0.0 稳定版，没有升级到 npm beta，也没有修改用户全局 CLI 配色配置。

### 真实验证

在隔离数据目录、单独网关与 Vite 端口进行浏览器测试。OMP 使用 `--no-session`；Codex 启动空会话，仅输入未提交的中英文草稿，没有提交模型任务。

| 场景 | 观察结果 |
| --- | --- |
| OMP 深→浅→深 | 输入草稿保留，菜单/状态文字切换；捕获 `997;1n` → OMP `OSC 11;?` → 终端回复黑色的真实往返 |
| Codex 0.153.4 | 启动发出 OSC 10/11，收到真实颜色；没有观察到 2031 订阅；按该 WebSocket 单独筛选，切换后没有颜色重查 |
| 固定深色 | 工作台保持浅色，终端背景、边缘、输入文字保持深色组合 |
| WebGL/DOM 对比度 | `1` 时浅底浅字几乎不可读，`4.5` 时文字清晰；原始背景、diff 色与反色保留其语义 |
| 原生解析兼容 | 分片 `2031h`、能力查询、996、BEL 终止 OSC、OSC 设置 `#123456` 与堆叠查询均通过 |

可复用浏览器样例：启动前端后打开 `/tests/browser/terminal-appearance.html`。它只展示合成数据和协议结果，不接触真实会话。

最终 `npm run verify` 通过：各 workspace 合计 **178 项测试**，全部类型检查、前端构建与源码边界检查通过。构建仍有项目原有的大 chunk、3dmol eval 警告。

### 实施期间的运行事故

重载本地开发服务时，停止 concurrently 父进程触发递归进程树清理，也停止了原 daemon 和两个 PTY。旧进程状态无法恢复；会话记录仍在，后续已有新的 shell PID，但这不等于旧 CLI 任务恢复。已向用户说明，并修正 daemon 启动为短生命周期中间启动器，避免继续处于网关后代树中。详见 [进程树生命周期记录](20260907-daemon-process-tree-lifecycle.md)。

## 调研结论

可以借鉴的成熟组合是：**默认色与调色板配置 + 按单元格的字色对比度补偿 + CLI 主动参与的颜色查询和主题通知**。这三个层次解决不同问题。优先用对比度补偿改善截图里的可读性，再建立 OMP 等应用可以使用的同步闭环；Codex 按实际版本单独验证并保留稳定配色的降级选项。

终端侧改动已经落地，Codex 内部缓存配色与大型历史重着色仍有上述边界。外部 `main/master` 与在线 issue 状态可能变化，后续升级时仍需核对发行状态。
