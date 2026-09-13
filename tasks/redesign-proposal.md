# 决策记录（2026-09-06）
# - A 主色：保持单色，不引品牌蓝。
# - B 文案：按 §4 对照表全中文化。
# - C header：统一 h-9，图标按钮同步收到 h-5 w-5（含笔记抽屉从 h-10 收敛）。
# - 圆角映射：sm=rounded-md(6) / md=rounded-lg(8) / lg=rounded-xl(12)，用 tailwind 现成 scale，不另起 token。

# 前端视觉重设计提案（v1，待拍板）

方向：视觉质感，不动三栏布局（会话 / 终端 / 文件），不增删功能。分块落地，每块可独立上线。

## 现状审计（依据：`index.css`、`theme.tsx`、各面板组件）

1. **色板是“伪单色”**：`accent` 白/黑可用，但 `danger` 在两套主题下都是灰（`#a1a1a6` / `#6e6e73`），错误读不出错误感；于是各处又内联 `text-red-400` 打补丁。成功绿、警告黄完全缺失（冲突条、截断条都用 `bg-hover`，层级 invisible）。
2. **圆角/阴影/字号全是任意值**：`rounded`、`rounded-md/lg/xl/full`、`rounded-[10px]` 混用；阴影 `0 10px 28px` / `0 12px 40px` / `0 24px 80px` 三处手写；字号 `text-[11px]` / `text-xs` / `text-[13px]` / `text-[12.5px]` 随手写。
3. **四个 header 四种写法**：Sidebar / TerminalPane / FileTreePane 是 `h-9`，NotesDrawer 是 `h-10`；标题字重、cwd 副标题、按钮组各写各的。终端 header 现在已经 1 logo + 标题 + cwd + 3 按钮，再加就挤爆。
4. **中英文案随机**：`Sessions` / `收起会话栏` / `New` / `过滤文件…` / `File changed on disk` 同屏出现，无规则。
5. **通知无体系**：冲突条、截断条、复制 toast、`Binary file` 纯文本，各自为政；成功态（保存成功）现在是静默的。
6. **焦点态缺失**：全局几乎没有 `focus-visible`，键盘用户看不见焦点。

## 提案

### 0. 原则

- 保留 Apple 单色骨架（用户群是 Mac + SF 字体，已经顺眼），只补“功能色”。
- 密度不变：不加大 padding、不搞大留白，只收紧对齐。
- 消灭任意值：所有新样式只用下表的 token；旧任意值按组件分批收敛。
- 中文优先：界面中文，技术名词保留英文（Shell、PTY、CLI、cwd 不译）。

### 1. 色板（只加三处，其余不动）

| 用途 | dark | light | 说明 |
| --- | --- | --- | --- |
| danger（替代现有灰） | `#ff453a` | `#d70015` | Apple systemRed，两端可读 |
| warning（截断/冲突条） | `#ffd60a`（配黑字）或条带底色 `rgba(255,214,10,.12)` + 黄字 | `#9a6b00` 字 + `rgba(154,107,0,.10)` 底 | 信息条专用 |
| success（保存/复制 toast） | `#30d158` | `#248a3d` | Apple systemGreen |

`accent` 保持白/黑不动（**待拍板 A**：要不要引入品牌蓝 `#0a84ff` 做主操作/焦点？提案默认不引，保持单色）。

### 2. 字阶（4 档，行高固定）

| token | 大小/行高 | 用途 |
| --- | --- | --- |
| `text-caption` | 11px / 1.45 | 时间戳、计数、cwd、footer |
| `text-body` | 13px / 1.55 | 列表、按钮、输入 |
| `text-title` | 14px / 1.4 + semibold | 面板标题 |
| `text-mono` | 12px / 1.55 | 终端外所有 mono（cwd、char 数、log 名） |

现有 `text-[11px]`→caption、`text-xs`（12）→ 按场景二选其一、`text-[13px]`→body、`12.5px` 的编辑器/预览→13px body。中文 13px 在非视网膜屏不发虚，12px 只留给 caption/mono。

### 3. 圆角 / 阴影 / 间距

- 圆角：`sm=6`（输入框、小按钮）/ `md=8`（列表行、条带）/ `lg=12`（弹窗、抽屉、菜单）；废除 `rounded-[10px]`、`rounded-xl`（16 只留文件弹窗？统一用 lg=12，弹窗不再特殊）。
- 阴影三档：`pop`（菜单、下拉）`0 8px 24px rgba(0,0,0,.35)` / `modal`（文件弹窗）`0 24px 64px rgba(0,0,0,.5)` / `drawer`（笔记抽屉）`-16px 0 48px rgba(0,0,0,.45)`（现状值已接近，只收进 token）。
- 面板 header 统一 `h-10`（现状 h-9 vs h-10 打架，选 10，给图标按钮呼吸空间）；行高触击区不低于 28px。

### 4. 文案对照（中文优先，技术词不译）

Sessions→会话，Files→文件，New→新建，Terminal→终端，Reopen→重新打开，Kill session→结束会话，Hide session→隐藏会话，Save→保存，Edit/Done→编辑/完成，Reload/Keep Mine→载入最新/保留我的，Search→查找，Copy→复制，No session selected→未选择会话，Empty directory→空目录。`Shell exited`→`Shell 已退出`，`Reconnecting…`→`重连中…`。保留英文：PTY、CLI、cwd、Markdown 文件名、快捷键符号（⌘B/⌘K 不动）。

### 5. 共享组件（本次核心，新建 `components/ui/`，不准再手写）

1. **`PanelHeader`**：`{ title, sub?, actions? }`，统一 h-10、标题字阶、副标题 caption。替换 4 个手写 header（Sidebar、TerminalPane、FileTreePane、NotesDrawer 换肤）。
2. **`IconButton`**：统一 h-6 w-6、tooltip 必填、hover/disabled 一致。替换约 20 处手写按钮。终端 header 按钮超 4 个时自动收进 `…`（先定规则，实现时看数量，不超就不做）。
3. **`NoticeBar`**：`tone: info | warning | error | success`，替换冲突条、截断条；落地页脚的纯文本提示（Binary file 等）并入此体系或 Empty。
4. **`Toast`**：替换复制 toast，补“保存成功”轻提示（2s 自消，静默太久用户会再点一次保存）。
5. **`Empty`**：统一空态（图标 + 一行字 + 可选操作），替换 No session/Empty directory/No matching files/无抽屉选中态。
6. **焦点环**：全局 `focus-visible` 2px accent 描边（终端输入区、CodeMirror 除外）。

### 6. 逐面板改动清单（只换皮，不改行为）

- **Sidebar**：PanelHeader（标题“会话”，副标题为在线数）；会话行 hover 操作延用；dnd 指示条颜色 accent 不变。
- **TerminalPane**：PanelHeader（标题=会话名，副标题=cwd）；搜索/导出/笔记三按钮 + cwd，超宽时 cwd 先截断（现状 `max-w-[45%]` 保留）；搜索行、rails 样式换 token。
- **FileTreePane**：PanelHeader（标题“文件”）；过滤/新建两行合并为工具行（视觉合并，功能不动）；树行高统一 28px；弹窗换 lg 圆角 + modal 阴影 token，header h-10。
- **NotesDrawer**：换 PanelHeader（去掉“存于本机浏览器”小字→移到设置？现状保留，字阶换 caption）；tab 样式与分段控件统一。
- **浅色主题**：按新三色重走一遍；CodeMirror monochrome 主题已读变量，自动跟随，只需补 warning/danger/success 在编辑器语境下的对比度检查。

### 7. 非目标

布局/面板尺寸逻辑不动；折叠、拖拽、恢复协议不动；不加动画库新用法（NewMenu 的 framer-motion 保留）；不等宽字体栈不动。

### 8. 实施分块（每块独立可验）

- P1 tokens：`index.css` 加三色 + 字阶/圆角/阴影语义类（或 tailwind theme 扩展），零组件改动。
- P2 ui 组件：新建 6 个共享组件 + 替换一处试点（NoticeBar 先替截断条）。
- P3 面板迁移：Sidebar → TerminalPane → FileTreePane → NotesDrawer，逐个提验。
- P4 弹窗与空态：文件弹窗换肤 + Empty 全量替换。
- P5 浅色主题走查 + 双主题截图对照 + 文案终校。

验收（每块）：双端 typecheck、前后端测试、`npm run build`、浅/深双主题浏览器走查截图。

## 待你拍板

- **A**：accent 保持单色（提案默认），还是引入品牌蓝？
- **B**：文案按 §4 全中文化，有没有哪条想保留英文？
- **C**：header 统一 h-10（提案默认）还是 h-9？h-9 更紧凑但图标按钮得缩到 h-5。
