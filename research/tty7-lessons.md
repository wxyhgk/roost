# 从 tty7 学到的：尺寸回声

<https://github.com/l0ng-ai/tty7> —— 和 roost 同类的东西（terminal workbench：持久会话、
远程、agent），纯 Rust + Zed 的 gpui + Alacritty 的 VT 核心。源码在
`research/third-party/tty7`（该目录被 gitignore）。

只记对 roost 当下有用的部分，不做全面综述。

## 一、最值钱的一条：resize 要在**字节流里**同步，不是"同时发出"

`crates/tty7-core/src/daemon/protocol.rs` 的 `FEATURE_RESIZE_ECHO`：

> 守护进程在应用一次 `ClientMsg::Resize` 时，**按流序**向控制端回一个 `DaemonMsg::Size`。
> 认得这个特性的客户端，把自己的网格 reflow **推迟到这个回声**，而不是窗口一变就 reflow。

`daemon/pane.rs` 的 `resize_state` 上方写了理由，逐句都对 roost 成立：

> 回声必须在**持有状态锁时**发出——输出也在同一把锁下扇出，所以这一帧落在"按旧尺寸产出
> 的最后一个字节"之后、"PTY 真正改完尺寸后吐的重绘"之前。
>
> 通道里可能积着**几兆**旧宽度的输出（窗格闸门允许 16 MiB），抢在它们前面 reflow，就等于
> 把旧宽度的字节解析进新宽度的网格，**在一阵输出中途最大化窗口时，窗格就花了。**
>
> 这个标记**故意不是密不透风的**：读线程已读出但还没扇出的、以及还躺在内核管道里的字节
> （ConPTY 在处理完 resize 前还会继续产出），会落在回声之后按新宽度解析。那部分残留被
> 一次 64 KiB 读加管道容量框住，**从这里无法归因到某个几何**（字节不带标签，ConPTY 也不
> 发自己的同步标记），是所有 ConPTY 终端在输出中途 resize 时都接受的同一份歧义。
> **回声是用来关掉那个 16 MiB 窗口的，不是这个。**

### roost 现在是反过来的

`sessionController.ts` 的 `fit()`：

```js
term?.fit();              // 本地立刻 reflow
const told = conn?.fit(); // 然后才告诉守护进程
```

本地先按新宽度重排，再通知。而**已经在 WebSocket 上飞着、按旧宽度产出的字节**，到达时会
被这个已经重排过的终端按新宽度解析。

**跨太平洋那条链路上在途字节最多**（实测往返 ~200ms、走 DERP 中继），所以这个窗口在
roost 的主力使用场景下恰好开到最大。这是目前对「一段时间后画面变脏」最好的解释，也解释了
为什么是"**一段时间后**"——得在有输出的时候拖一下面板宽度才会触发。

`issues/2026-09-10-restore-loses-rows-below-cursor.md` 反复强调的「本地终端和 PTY 的尺寸
必须一起改」，说的是同一件事，但那条不变式只保证了**同时发出**，没保证**同一个流位置**。

### 完整的解法是三个零件，缺一不可

四路并行里有三路独立推荐了这一套（第四路是 agent 集成，另一个题目）：

1. **重放环按录制时的几何分段**，每段先发 `Size` 再发字节（`daemon/pane.rs:2685-2690`）。
   他们的 CHANGELOG 记了不这么做的后果：整个环按最终宽度重放，会话中途任何一次 resize
   都会让旧输出重新折行，TUI 的 cursor-up 重绘落在半帧上。
2. **活着的时候，daemon 在应用 resize 的那个流位置回一个 `Size` 帧**，客户端把 reflow
   推迟到那个标记（上面那段注释）。
3. **模式 fold 只补环自己补不上的那部分**（`pane.rs:2749`）。这条最容易漏：重复发一次
   `?1049h` **不是无害的**——模式已开时 emulator 当它 no-op，于是环自带的那份不再清
   alternate screen，环里更早的 shell scrollback 会被画进 alternate buffer，然后随程序
   退出一起丢掉。

   **查过了：roost 没有这个病，因为架构不同**（2026-09-16 [实测]）。tty7 重放的是原始
   历史，所以 fold 必须替它补窗口之前的模式；roost 重放的是**服务端网格重新序列化出来的
   当前画面**，alt screen 状态由快照自带——实测 SerializeAddon 排出来的正是
   「normal 回滚 → `?1049h` → alt 内容」。而 roost 的 fold（`mouseModes.ts`）刻意只管
   9/1000/1002/1003/1005/1006/1007/1015/1016，**47/1047/1049 不在里面**，所以它不可能
   重复发那一条；全仓库也没有任何地方无条件发 `?1049h`。

   真正撑住这条的是「全量重放前先 `reset()` 回 normal buffer」，而这件事原来一条断言都
   没有。补在 `frontend/tests/resume-altscreen.test.ts`：把目标终端先摆进别的 TUI 的
   alt screen 再重放，回滚必须还在 normal 里。去掉 reset 就红。

   **剩一个降级路径没解**，见
   `issues/2026-09-16-alt-screen-lost-when-server-screen-breaks.md`。

**顺带一个副作用**：零件 1 让「网格对不上」不再是错误状态，于是 roost 那条
「重连 → 服务端网格 ≠ 客户端网格 → 整个缓冲判废 → 全量重建 → 只剩 2000 行」的因果链
在第二环就断了。attach 时服务端**明确忽略客户端报的网格**（`daemon/server.rs:814-817`，
`size` 参数直接写成 `_`）。

**三个零件里前两个已经做了**：零件 2 是 `a58fa74`（尺寸回声），零件 1 是本条之后的那笔
（重放帧带上几何切换点的下标，`ReplayFrame.resizes`）。**零件 3 还没做。**

而 roost 2026-09-16 那笔「恢复画面时抖一下尺寸逼 TUI 重画」
（`ea71792`）是在用副作用绕过这个问题——当时提交信息里就写明了「只是让用户重新有个能用
的东西，不是修因」。这里才是因。

## 二、替 agent 按回车：他们睡 200ms，我们等回显

`tty7-cli/src/commands.rs` 的 `send`：

```rust
const KEY_GAP: Duration = Duration::from_millis(200);
// Raw-mode TUIs detect a fast stream as pasted input and intentionally absorb
// Enter as a newline — and a menu being driven by arrow keys has the same
// problem. Let each keystroke leave the burst window on its own.
```

**印证了同一个现象**：正文和回车挤在一个突发里，TUI 会把它当粘贴、把回车吞成换行。

两边的答案不同：tty7 猜一个够长的间隔（200ms）；roost（2026-09-16 起）**贴完等到在屏幕上
看见自己那段正文再按回车**——等证据不等时间。roost 这条更稳，但代价是丢掉了单次写入的原子性。

顺带：roost 原来能用「括号粘贴 + 同 buffer 回车」一次写成，是因为 `ESC[201~` 显式界定了
粘贴范围，那个 `\r` 落在粘贴之外。tty7 的 send 不用括号粘贴。

## 三、两边各自领先的地方

**roost 领先**：~~tty7 没有本地回显~~ —— **这句我先前说错了一半，四路并行时被纠正**。

tty7 没有逐键预测＋回显对账，但它有更激进的东西：**在 shell 提示符下客户端直接接管整行**
（`src/terminal/cmd_editor.rs`，915 行纯 `Vec<char>` 行编辑器，零 I/O），按键根本不过网，
提交时才发一次。回归测试把契约钉死：`view.rs:15994` 的断言信息是
*"the editor owns these keys, so none of them reach the PTY"*。

**但它的生效条件很窄**（`view.rs:4246-4274` 逐条列了失效原因）：关了设置 / shell 已退出 /
搜索框占键盘 / **在 alt screen** / shell 处于 vi 模式 / **没有 OSC 133 提示符标记**。
也就是说 **vim、htop、以及所有 agent TUI 里这条路完全不存在**——那些场景下 tty7 每个按键
都是完整 RTT，一点缓解都没有。

**所以在 roost 的主力场景（agent TUI + 200ms 链路）上，roost 的覆盖层反而是更强的那个**：
它不进 parser、不进网络、失败就撤销，最坏是白画一帧；而 tty7 为了让本地编辑器接管，
**必须真的往线上写 `\x15`（Ctrl-U）** 去擦 shell 缓着的那行，为此背了 tainted / owed-wipe /
handoff / gap-hold 四套状态机，`view.rs:11651`、`:11696`、`:12367` 那些「恢复 shell 时不能
凭空合成 Ctrl-U」的回归测试，每一条背后都是真把用户命令行搞坏过一次。

另外两条 roost 更好的：**延迟读数测在承载按键的那条链路上**（roost 的 ping 走的就是运 PTY
字节的那个 websocket；tty7 把 latency row 测在 Control channel，而按键走 Pane channel，
是两条独立的 SSH channel、各有各的流控窗口），以及 roost 显式建模了「这个读数多老」
（`StatusBar.tsx` 的 45 秒过期）。

**两家共同的缺口**：延迟读数都没有平滑。tty7 是单个 atomic 直接覆盖（`control.rs:1145`），
roost 同样。在 170→403ms 抖动的链路上，单样本读数会乱跳。

**tty7 领先**：
- **特性协商**（`FEATURE_*` 字符串 + `PROTOCOL_VERSION`）而不是钉版本号。roost 2026-09-16
  刚把 claude 的版本钉子换成读画面，方向一致：别问"谁验过这个版本"，问"能力在不在"。
- **agent 状态全走 hook，不读屏**，覆盖 15 个 CLI（roost 是 claude + qwen）。文档里老实写
  了缺口：Crush 只有 `PreToolUse`、没有回合边界，所以它没有状态点、`tty7 wait` 会超时。
- **`send` 一道闸门都没有**——不查前台、不认画面。安全性靠"调用方明确指定了窗格"。
  roost 的闸门多得多（前台 tpgid、画面分类、epoch、粘贴回显确认）。这是取舍不是优劣：
  tty7 的 send 是 CLI 原语（人/脚本明确发起），roost 的是网页按钮（可能来自另一台设备）。
