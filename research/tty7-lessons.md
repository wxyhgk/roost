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

改动形状：协议里加一个按流序插入的 size 帧，客户端收到它才 reflow。**这是协议改动，没做。**

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

**roost 领先**：tty7 **没有本地回显/预测**（全仓搜不到 predict/speculative，只有一个显示
"到对端距离"的延迟读数）。远程窗格里打字就是完整往返。

**tty7 领先**：
- **特性协商**（`FEATURE_*` 字符串 + `PROTOCOL_VERSION`）而不是钉版本号。roost 2026-09-16
  刚把 claude 的版本钉子换成读画面，方向一致：别问"谁验过这个版本"，问"能力在不在"。
- **agent 状态全走 hook，不读屏**，覆盖 15 个 CLI（roost 是 claude + qwen）。文档里老实写
  了缺口：Crush 只有 `PreToolUse`、没有回合边界，所以它没有状态点、`tty7 wait` 会超时。
- **`send` 一道闸门都没有**——不查前台、不认画面。安全性靠"调用方明确指定了窗格"。
  roost 的闸门多得多（前台 tpgid、画面分类、epoch、粘贴回显确认）。这是取舍不是优劣：
  tty7 的 send 是 CLI 原语（人/脚本明确发起），roost 的是网页按钮（可能来自另一台设备）。
