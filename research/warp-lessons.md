# 从 Warp 学到什么（四路调研的合并结论）

2026-09-15。材料：`research/third-party/warp`（Warp 终端开源代码，79 个 crate + 289 份设计
文档）。四个 agent 分头读了 TUI↔GUI 关系、block 与输出洪流、AI agent 集成、历史持久化。

**许可证**：除 `crates/warpui_core` / `crates/warpui`（MIT）外全部 **AGPL-3.0-only**。抄代码
会把 roost 拖进 AGPL。这份笔记只记设计与协议形状，不搬代码。可安全复用的只有**互操作
线格式**（OSC 777 的 sentinel 字符串、事件名、环境变量名——协议标识符不是版权代码）。

---

## 零、先划掉：我们已经有的

四份报告里有三份把这条列为 P0，但它**已经在仓库里**，而且是照 Warp 的协议做的：

| Warp | roost |
| --- | --- |
| OSC 777 + sentinel `warp://cli-agent` | `packages/terminal-protocol/src/agent-events.ts` 同一套 |
| `WARP_CLI_AGENT_PROTOCOL_VERSION` / `WARP_CLIENT_VERSION` 能力协商 | `terminal-runtime/src/index.ts:83-84` 每个 PTY 都注入 |
| 九个事件词（session_start … idle_prompt） | `backend/src/session-status.ts` 一字不差 |

另一条也别重复造：「把 PTY 唤醒合并到 60fps」——**xterm.js 的 `RenderDebouncer` 本来就在
做**，我们自己那份洪流调研（`tasks/terminal-flood/README.md` 三点五）已经实测过。

---

## 一、最该做的：把「敢不敢写」从认屏幕改成看状态

这是四份报告的交集，也是我们当前最脆的地方（`claude-screen.ts` 用正则认 claude 的 TUI
长什么样，并因此把版本钉死在 2.1.266）。

**Warp 在这条路径上一个正则都没有**（agent 全仓库 grep 过 `cli_agent_sessions/`、
`use_agent_footer/`、`agent_sdk/driver/harness/`，零命中）。他们的形状是：

1. **一个闸门函数 + 一个显式状态**。`write_user_bytes_to_pty()` 第一件事就是
   `if active_block.is_agent_in_control() { return false; }`
   （`app/src/terminal/view.rs:9813-9840`）。输入权是显式转移的，还带类型化错误
   `InvalidTakeOver` / `InvalidHandOff`（`model/block/interaction_mode.rs:346-353`）。

   → **我们现在没有这个状态，所以只能去看屏幕。** 先把结构立起来，哪怕状态暂时还是猜的；
   以后换成事件驱动只改一个填充点。

2. **Blocked 时让路，不是避开**。收到 `permission_request` 就**把 GUI 输入框关掉**，让键盘
   直通终端，用户在 TUI 里原生回答（`app/src/terminal/view.rs:13907-13940`）。

   → 这比「认出权限框再小心避开」正确得多，也简单得多。**而且我们已经收得到这个事件**
   （`SessionAgent.waitingFor === 'permission'`）——现在只是把消息排队标成 `dialog`，
   没有让路。

3. **发送策略做成一张按 agent 的小表**，不是统一逻辑
   （`view/use_agent_footer/mod.rs:104-146`）：

   | 策略 | 用于 | 理由（他们的注释） |
   | --- | --- | --- |
   | `DelayedEnter`（文本 →50ms→ `\r`） | **Claude**、OpenCode、Gemini、Grok | 这些 agent「对与文本同一 buffer 到达的 `\r` 不响应」 |
   | `BracketedPaste` | Codex、OhMyPi | 它们的 paste-burst 启发式会吞掉紧随字符流的 Enter |
   | `BracketedPasteDelayedEnter`（300ms） | Copilot | 两者都要 |

   `!` / `&` 这类模式前缀要**单独先发**再延迟发正文，「给 Claude Code 时间识别前缀并切换模式」。

   → 这张表也会随版本失效，Warp 没解决这个。但**失效模式是「消息没发出去」，不是「消息
   发到了错的地方」**——比正则认屏幕好一个量级。

**结论：`claude-screen.ts` 那套可以整条退役，版本钉子跟着一起解掉。** 但有一条不能照抄：
Warp 往 PTY 写字用 kill-buffer + bracketed paste + CR，**kill-buffer 会把用户的草稿直接清掉**。
他们用确定性换掉了草稿保护。我们那道 `terminal_draft` 闸是有意义的功能，要保留。

---

## 二、`--session-id` 能接受全新 UUID —— 悬着的问题答了

我们之前不确定这一条，还特意绕开了（改成让 CLI 自己报身份）。**Warp 的生产代码证明可行**
（`app/src/ai/agent_sdk/driver/harness/claude_code.rs:203-220`）：

```
新会话：claude --session-id <自己生成的 uuid> < '<prompt 文件>'
恢复：  claude --resume <同一个 uuid>
```

首条 prompt 走 **stdin 文件重定向**，不是键入——专门为了绕开 shell quoting。

→ 意味着我们可以**先铸 id 再起 CLI**：转录路径可预测，不用「认领」身份。当前那条绕法
（让 CLI 自己报）能用，但这条更直接。

⚠️ 两个附带事实，只当情报，**不建议照搬**：他们给子 agent 起 claude 时带
`--dangerously-skip-permissions`，且隐藏 pane 里的子会话**无条件跳过确认**（理由是看不见的
确认卡会把运行卡死）。这是安全权衡，不是最佳实践。

⚠️ **cwd 是 claude 会话身份的一部分**（jsonl 每行内嵌自己的 cwd），切目录后恢复会踩坑。

---

## 三、外部真相源当脊梁 —— 直接对着我们的「29 vs 4」

Warp 的命令历史列表**不以自己的数据库为准**（`app/src/terminal/history.rs:605-643`）：

```
shell 的 histfile   ← 列表的脊梁
  ∩ SQLite 记录     ← 只是元数据 overlay（exit_code / 时间 / cwd）
  没记录过的        → HistoryEntry::command_only(cmd)，照样出现在列表里
```

排序时这类条目拿中性分（`MISSING_TIMESTAMP_RECENCY = 0.5`，注释：「没有数据支持把它当成
新或旧」）。

→ 我们磁盘上 29 个 claude 会话、目录里只有 4 个。解法是同一个形状：**枚举
`~/.claude/projects/*/*.jsonl` 当脊梁，roost 的库做 overlay，join 键用 session uuid**。
没记录过的降级显示（无标题、时间取 mtime、排序给中性值），而不是消失。

**诚实的一半**：Warp 对 CLI agent 会话**没做**这件事——它只知道自己启动过的会话，和我们
一模一样的盲区（`claude_transcript.rs` 从不枚举 projects 目录）。所以这不是「我们落后」，
是**我们有机会做得比它好**。

---

## 四、一条该知道的：我们想做的那件事，Warp 没做过

用户的核心主张是「GUI 和 TUI 同步」。**Warp 没有任何「同一个 shell 会话被 TUI 和 GUI 同时
打开并双向同步」的实现。** 他们的 TUI 是一个独立的 agent CLI，不是 GUI 会话的第二个视图：

- 两个进程、两套二进制、**两个本地 SQLite**，故意隔离。理由明写
  （`app/src/persistence/mod.rs:69-77`）：「TUI 自己一个库，这样 GUI/TUI 版本错位永远不会
  把共享库迁移到老二进制脚下。**云同步才是跨前端的共享机制。**」
- 设置也是两份、密钥也是两个 namespace。
- GUI↔TUI 之间**没有 IPC、没有 socket、没有锁文件、没有握手**。
- 同一个会话被两边同时打开 = **裸奔的 last-writer-wins**，他们自己在
  `specs/REMOTE-1373/TECH.md:103` 承认了。

**最接近的参照不是 GUI/TUI 关系，是他们的 shared session**（多人共享一个终端）：
**严格单写者**——只有 sharer 拥有 PTY，viewer 完全没有 PTY，只能发请求
（`WriteToPty` / `ExecuteCommand` / `SendAgentPrompt`），由 sharer 重新校验后才落地；共享的
输入框用 **CRDT**。

→ **这对我们是结构性优势，不是落后。** roost 的后端进程独占 PTY，浏览器只发意图——这个
形状本来就是对的，而且我们能做到 Warp 做不到的「一份权威状态、两个投影」。
**别为了模仿 Warp 而把它拆成两个进程两个库。**

Warp 自己也把这条当原则用在**模型层**（spec 明写）：TUI 的权限卡片从共享的
`AIActionStatus::Blocked` 推导，「**这样权限策略和 GUI 共享，而不是在 TUI 里再复制一个
分类器**」（`specs/CODE-1809/TECH.md:70`）。能力差异只允许发生在呈现层。

还有一个细节值得抄：**当 TUI 本身已经是一个 agent 界面时，外层 GUI 主动隐藏自己的输入条**
（`view.rs:8681-8686`）。我们的 GUI 输入框叠在 claude 的输入框上，是同一类问题。

---

## 五、洪流：Warp 没绕开，和我们的结论一致

- **他们也没治。** `FullGridClearBehavior::Clear` 只拦整屏清除（`ESC[2J`）和 resize 重排；
  `claude --resume` 打历史是普通向下滚动输出，照样刷屏。他们做的是让刷屏**不痛**
  （扁平存储 + 窗口化绘制 + 60fps 合并），不是让它消失。
- **没有背压**。PTY 线程从不阻塞在渲染侧。
- 一条值钱的不变式（`specs/tui-output-redraw/TECH.md:45`）：

  > agent 活跃重绘期间，可见行是**可变的帧表面**，不是历史输出；把它们存进 scrollback，
  > 就是把转瞬即逝的帧变成累积的输出。

  关键背景：**Claude Code 不用 alt screen**，它在主屏重绘，所以「alt screen 走旁路」那套
  保护对它完全无效。

  → 这条对 xterm.js 是否成立**我们还没测**。值得测一次：agent 活跃期间的 `ESC[2J` 和
  resize 会不会在我们这边堆出 scrollback。

- 他们给出的唯一真解和我们的判断一样：**不要让 TUI 重打印，改成自己读转录渲染**，代价是
  复刻 Claude Code 的 UI。

---

## 六、持久化上的校准

- **Warp 完全没有 schema 版本门禁**：没有 `PRAGMA user_version`、没有版本戳，
  `__diesel_schema_migrations` 从不被应用代码读。唯一防线是**路径分离**（每渠道一个库、
  GUI/TUI 各一个库）。迁移失败就**降级启动**（不恢复会话），不删库不备份。

  → 我们用 SQLite 触发器做写入者门禁，**比一个成熟产品激进得多**。不是说我们错了，但
  值得知道这个参照。

- **迁移哲学是「只加不改」**：新列一律 nullable；**新字段往那个 opaque 的 JSON 列里塞，
  从此大部分演进不需要迁移**（`specs/zachlloyd/restore-fast-forward-state/TECH.md:88`）；
  新 JSON 字段一律 `#[serde(default)]`；格式错误 = 记日志回落默认值，不报错。

- **没有二级索引、没有 FTS**。141 个 migration 里全部索引都是 UNIQUE 约束（给 upsert 当
  冲突目标）。启动时整库读进内存，检索用 skim fuzzy + 一张调好的先验表
  （recency 半衰期 3 天权重 0.10、同会话 0.05、上次失败扣 0.03，先验只做 ±20% 微调，
  匹配质量始终占主导）。

  → 我们 4789 条消息完全放得进内存。**别急着上 FTS5。**

- **驱逐的原子单位是会话不是消息**：agent 对话按编排树整棵淘汰，被拒绝的方案写着
  「严格计数上限会把活跃会话在磁盘上劈成两半」（`specs/QUALITY-768/TECH.md:87`）。

- 一个可迁移的小教训：他们有个真 bug——随机 `u64` 存进 SQLite 的 `i64` 列时约一半溢出成
  NULL，连带退出码永远回填不上。**往 SQLite 存 u64 id 之前先掩成 63 位。**

---

## 七、他们试过然后放弃的（specs 明写，最值钱的一类信息）

| 放弃的做法 | 理由 |
| --- | --- |
| **用屏幕自动化控制应用** | 换成带类型、带权限的控制面，「而不是脆弱的屏幕自动化」（`specs/warp-control-cli/PRODUCT.md:9`）。而且那个控制面**故意不提供提交能力**：只能 `input.insert` / `input.replace`，**永远不替你按回车** |
| **「装了插件 = 能拿到结构化状态」** | 改成 `supports_rich_status()`，唯一判据是**真的收到过一条 OSC 777**。磁盘上装没装不算数（`specs/codex-warp-plugin/TECH.md:6-8,61`） |
| **`Cell::is_empty()` 当「这行是空的」判据** | 被推翻：「曾经是临时建议菜单的行会被清成**视觉上空白但 `is_empty()` 仍为假**的单元」。改成一个只用于 CLI-agent 裁剪的专用谓词，并明确写「不要重新定义终端级的 empty」 |
| **解析 shell 命令推断它改了哪些文件** | 两次被否为 brittle |
| **往用户可见终端注入命令**（作为工具执行通道） | 「慢、脆、污染终端输出」 |
| **持久化「等待中」状态** | 「它为一个进程内概念引入了持久状态，带来陈旧风险……**诚实的模型——『等待随进程死亡而结束』——表面积更小，降级更优雅**」 |

最后一条的思路值得单独记：**不要为了界面好看去持久化一个本质上是进程内的事实。**

---

## 八、优先级（我的判断，不是 Warp 明写的）

1. **退掉读屏**：闸门函数 + 显式状态 + 按 agent 的发送策略表 + `permission_request` 时让路。
   同时解掉版本钉子。这是投入产出比最高的一条。
2. **外部真相源当脊梁**：治「29 vs 4」，而且能做得比 Warp 好。
3. **`--session-id` 自己铸身份**：小改动，换来可预测的转录路径。
4. 测一次那条「帧表面 vs 历史输出」的不变式在 xterm.js 上成不成立。
5. 持久化那几条只是校准，暂时不用动。

三条主线其实是同一句话：**少猜，多让对方告诉你。**
