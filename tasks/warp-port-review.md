# Warp 移植建议的核对记录

`muse_suggeest.md` 是一份「从 Warp 移植」的建议清单。核对下来它**有翻译错误，也有
我们早就具备的条目**，因此每条动手前都需要对着源码验证，不能照单执行。

Warp 源码在 `research/third-party/warp`（浅克隆，已在 .gitignore 中）。

## 判定为「不做」的条目

### 输出节流（清单最高优先级第 1 条）

清单原文：

> 输出节流=前沿+尾部合并 16ms：`warp/app/src/throttle.rs` + `warp_tui/terminal_session_view.rs:3351`。
> 首帧直写 + 窗口内只留尾帧，replay/catchup 不参与合并。落点 `frontend/src/terminal/sessionController.ts(onFrame)`
> + `connection.ts` + `resume.ts` + `packages/terminal-protocol`。成本 S，治 AI 流帧率抖。

**结论：不做。三层理由，一层比一层硬。**

**一、语义被误读。** `app/src/throttle.rs` 的实现会**丢弃中间项**——
`while let Poll::Ready(item) = stream.poll_next(ctx) { last_poll = item }`
把流抽干只留最后一个。它唯一的调用点在 `app/src/terminal/view.rs:3801`：

```
pub const MAX_WAKEUPS_PER_SECOND: u64 = 60;
wakeups_rx: Receiver<()>                    // 载荷是空元组
throttle(WAKEUP_THROTTLE_PERIOD, wakeups_rx)
```

节流对象是**重绘唤醒信号**，不是输出帧。丢弃中间项在那里安全，因为重绘请求是幂等的。
按清单落到 `connection.ts` / `resume.ts` 会**丢字节、损坏终端状态**——那两处经手的是
字节增量而非状态快照。

**二、我们没有对应物。** Warp 自绘 UI 需要手动限制重绘频率；我们的终端渲染由 xterm +
WebGL 自管（`term.write()` 内部已有帧调度），React 那层由 React 批处理管。

**三、前提不成立。** 清单说「治 AI 流帧率抖」。用真实 omp 经我们的 PTY runtime 实测：

| 场景 | chunk 速率 | 到达间隔中位 |
|---|---|---|
| AI 流（omp 长回答） | **10 次/秒** | 20.2ms |
| 基线（cat 大文件） | 118337 次/秒 | 0ms |

AI 流比 16ms 窗口还慢，固定窗口几乎不合并任何东西，只会给一半 chunk 加延迟。
真正的高吞吐场景（后者，高四个数量级）已由 `packages/terminal-runtime/src/resume.ts:31`
的背压合并覆盖（`batchLimit` 256KB，且不跨 reset/capture/prepare 屏障）。

**未覆盖的部分**：以上测的是 PTY 出口，不是 xterm 渲染端。若日后确有卡顿体感，
应先在 `frontend/tests/browser/` 加页面实测浏览器端帧率与输入延迟，再谈方案。

## 判定为「已具备」的条目

- **有界诊断环 50 条**：`frontend/src/terminal/diagnostics.ts:6` 已有上限 40，
  且有测试 `frontend/tests/terminal-diagnostics.test.ts`。

## 已采纳并落地的条目

- **IAP 熔断退避**（清单第 3 条）：属实且我们确实缺。重连原本无次数上限，
  已加 `offline` 状态 + 10 次上限 + 人工重试，见 commit `dde6700`。

---

## 全部核对完成后的最终判定

四组核对（终端渲染 / agent 协议 / 应用壳 / 工作区与实时链路）全部返回。总的模式是：
**Warp 侧的存在性基本都准，但语义归因和落点映射错误率很高**，共同成因是从文件名和
函数名反推语义，而没有读实现。

### 判定为「不做」的其余条目

| 条目 | 理由 |
|---|---|
| TUI 帧原地语义 | Clear 那半 xterm 默认就是（`scrollOnEraseInDisplay:false`）；真痛点是缩行不是缩列；xterm 未暴露任何 resize-scrollback 开关，干净解只能 fork |
| 高度缓存 + OVERHANG20 | 不适用——前提是 Warp 的混排块列表，我们只有单个 xterm 实例 |
| resize 所有权收敛 / PtyIntent | 已具备；后者的词汇表是杜撰的 |
| IME / 粘贴 / 链接配对 / footprint | 已具备，且部分比 Warp 更完整 |
| 恒下划线 + hover 加粗 | xterm decoration 仅 hover 生效且无 bold 字段，要补须自建 overlay 渲染层，收益纯视觉 |
| 起草期焦点保护 / 后台 owner 隔离 | 语义误读：Blocked 时 Warp 是关闭 composer 而非抢焦点；后者是 X11/CGEvent 桌面自动化，与我们无关 |
| per-conversation auto-approve | OSC 777 是单向只读通道，无法回话告知 agent；要做须先有一条双向路 |
| keymap 和弦层 | Web 侧插入点（`attachCustomKeyEventHandler`）语义与 Warp 的两趟模型相反；真正难点是和 tmux/vim 抢 Ctrl 前缀。**若日后要做，每个条目必须带 capture/bubble 相位标记**——⌘, 必须捕获才抢得到，Ctrl+B/J/K 必须留在冒泡让终端优先，合并成单一相位会必然弄坏其中一边 |

### 核对过程中发现的、清单上没有的问题（均已修复）

1. **会话置顶从未落库。** 前端整套接完（toggle、乐观更新、回滚、排序、关会话时跳过
   置顶），后端 `PATCH /api/workspace` 只认 `selectedId` 和 `expandedProjectIds`，
   其余静默丢弃且照样返 200——所以乐观更新不回滚、不报错，用户只看到「点了又弹回去」。
   这是整轮核对里唯一真正影响使用的缺陷，而它不在清单上。
2. **agent 状态机缺守卫。** `tool_complete` / `permission_replied` 无条件转 `working`，
   而 Warp 在这两处都有「仅当前为 Blocked 才转」的守卫。一条迟到的 `tool_complete`
   会把已到达的 `done` 翻回 `working`。
3. **协议丢字段。** OSC 事件 14 个字段只解析了 8 个，丢掉了 `summary`——那是协议已经
   拼好的、给人看的整句，所以通知只能写死通用文案。
4. **滚轮无余数累积。** PIXEL 模式下 `Math.max(1, ...)` 把任何非零 deltaY 放大成至少
   一行，触控板一次轻扫就滚十几行。xterm 自己有正确实现，是我们用捕获 +
   `preventDefault` 绕过去了。

### 唯一的真功能缺口

**文件监听**：核对确认全仓零文件监听，刷新按钮是唯一失效信号——终端里 AI 改的文件，
文件树完全不动。已实现（`backend/src/watcher.ts`），范围收敛为只报「这棵树变了」：
路径列表和变更种类都没有消费方，唯一的消费动作就是重拉目录。
