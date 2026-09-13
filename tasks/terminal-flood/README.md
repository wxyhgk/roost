# 终端输出洪流：调研结论与处置顺序

起因：`omp -r` / `claude --resume` 恢复对话时会把整段 transcript 重新打印到终端，几秒内几 MB。
用户观察到「滚动刷屏」，并确认在 iTerm 里同样如此。

四路并行调研（xterm 写入背压 / PTY 流控 / 本仓审计 / CLI 源头），结论如下。
标注 **[实测]** 的是本次跑出来的数字，**[源]** 的是从源码或官方文档核到的，其余为推断。

---

## 一、总结论

**只要还在 PTY 里跑 TUI，刷屏就治不了**——那不是 bug，是 TUI 在干它该干的事。三家 CLI 都没有
任何「安静恢复」的开关（逐条核过 `--help`、内嵌文档和配置项）。codex 甚至有人提过
`--history-lines` 的需求，被以「票数不够」关成 `not_planned`（openai/codex#12945）。

**但三家都提供了正式的宿主集成协议，resume 只给元数据、历史由宿主分页拉取。** 三家独立
收敛到同一设计，说明这就是宿主应用该走的门：

| CLI | 无洪流路径 | 关键点 |
|---|---|---|
| omp 18.1.16 | `omp --mode rpc-ui -r <id>` | stdio NDJSON，启动只发 `ready` 帧；`get_messages_page {cursor, limit}` 拉历史（≤256/页）；随包带 TS/Python 客户端 |
| claude 2.1.267 | Agent SDK `getSessionMessages(id, {limit, offset})` | 文档明写供「transcript viewers」用；`query({resume})` **只流新消息**；**禁止自己解析 `.jsonl`**（格式内部、随版本变） |
| codex 0.153.4 | `codex app-server` + `thread/resume {excludeTurns:true}` | 其自有 schema 称全量历史注水为「deprecated for paginated threads」 |

**而我们这个应用本来就自己存、自己渲染对话。TUI 是错的集成面。**

---

## 二、现在就该修（与架构无关）

### 1. 归档：一个输出块一个文件，无并发上限 —— 最严重

`backend/src/server.ts:96-101` 给每个会话挂归档，`backend/src/history.ts:119-133` 每块
`mkdir` + `writeFile` 一次，`void` 发射、不排队。一块约 700 字节。

**[实测] 本机现状：787,764 个文件、3.0 GB。单个会话最多 66,037 个文件。**
轮转阈值是每会话 256MB（`history.ts:7`），按当前块大小要攒到约 38 万个文件才删第一个。
而 `readPage` / `search` / `usage` 每次都 `readdir` + 正则 + 排序整个目录。

**改法**：每会话一个滚动文件 + 串行化的写队列，`mkdir` 用一次性标志。
**风险**：`flag:'wx'` 现在白送了重投幂等，改成追加要自己带 `lastSeq` 去重；且旧数据是另一种
布局，读取路径需要过渡期兼容两种。

### 2. 慢客户端不该被掐，更不该连坐

`backend/src/terminalTransport.ts:12`：`bufferedAmount` 超 4MB 直接 `ws.terminate()`。
而 daemon 那条 socket 也有 4MB 自毁（`terminal-daemon/src/wire.ts:5`），一旦死了
`backend/src/server.ts:1028` 会 `for … ws.terminate()` **掐掉每一个打开的终端**，然后全部
重连、全部请求完整重放，从同一根堵死的管子里挤。手机或慢网上一次 resume 就够触发。

**[源] tmux 在 2009/2015/2016 三次实现「因客户端慢而限制生产者」，三次都删掉了**，2016 年
那次的提交信息是 *"causing no end of trouble with disconnected clients stopping data in
attached ones"*。所以 `terminalTransport.ts:5` 那行注释的方向是对的，错的只是超限时的反应。

**改法**（tmux「丢渲染不丢字节」+ mosh「同步状态不同步字节」的安全版）：
1. 丢掉该客户端积压的输出
2. 在**服务端无头终端**上 `serialize()` 出当前屏幕
3. 当作 `snapshot` 帧发过去（协议里类型和 seq 语义已有）
4. 客户端 `reset()` + 写快照，从该 seq 继续

**前置**：`scripts/check-boundaries.mjs:20` 的 daemon 允许清单里只有 `@xterm/headless`，
要先把 `@xterm/addon-serialize` 加进清单和 `packages/terminal-daemon/package.json`。

**风险**：跳过那段的回滚历史对该客户端永久丢失（mosh 承认这是它最被抱怨的限制）。
建议只在 alt-screen 期间放开，那时回滚本来就没有意义。

### 3. 卡顿检测在洪流时必定失灵

写队列严格 FIFO，`pendingWrites` 永远只能是 0 或 1，而 `stalledParser`
（`frontend/src/terminal/diagnostics.ts:10`）正是看它。终端落后再多也报不出来。
`inspect()` 已经返回了 `queued` / `applied` / `received` 三个能说明落后程度的数，全被忽略。

**改法**：把判据换成 `received - applied` 加 `queued`，窗口沿用 10 秒。纯观测，零风险，先上。

### 4. codex 在 xterm.js 上有两个具体 bug

- **openai/codex#27644**（开）：codex 用区域滚动（`ESC[1;{B}r ESC[{k}S ESC[r`）往回滚区插历史，
  而 **xterm.js 只在整屏滚动时把行加进回滚缓冲，区域滚动是直接删掉**。所以 codex 的历史在
  我们这儿是**静默丢失**的。issue 里有实测过的重写方案。
- **openai/codex#41347**（开）：resize 会触发全量 transcript 重排。**我们是会改 PTY 尺寸的网页
  布局**，拖分隔条、收侧栏、切画布都可能触发。与 `42d9e39` 修的尺寸不同步是同一片区域。

### 5. `fitExact` 的零宽度保护比看上去薄 —— 会不可逆地毁掉回滚历史

`frontend/src/terminal/xtermEngine.ts:38` 的门槛是 `parent.clientWidth <= 4`，但下面减掉的
gutter 是 **14**：

```ts
if (!parent || parent.clientWidth <= 4 || …) return { cols: term.cols, rows: term.rows };
const gutter = term.options.scrollback === 0 ? 0 : 14;
const cols = Math.max(2, Math.floor((parent.clientWidth - gutter - 1) / cell.width));
```

宽度落在 5 到约 30 像素之间时会穿过这道门，算出负数，被 `Math.max(2, …)` 兜成 **2 列**。

**[实测]** 一个 20040 行的缓冲区 resize 到 2 列再回到 120 列：

```
resize -> 2 cols:   204ms, lines=20040
resize -> 120 cols:  24ms, lines=678
```

**19,362 行回滚历史被永久销毁**——重排到 2 列会把每行炸开约 30 倍，冲爆 20000 行上限被裁掉，
再排回来也救不回来。

**改法**：把门槛提到 gutter 之上（比如 `clientWidth <= 40`）。一行。
**可达性**：面板有 `minSize` 约束，正常操作大概率到不了；但这是不可逆的数据损失，
而修它只要一行。

---

## 三、明确不做，以及理由

| 方案 | 不做的理由 |
|---|---|
| **PTY 流控（按解析器积压去 `pty.pause()`）** | 它要解决的问题不存在。**[实测]** node-pty 每轮最多交付 1024 字节，解析器 97MB/s，灌 29MB 全速输出 `broken` 从未触发；**故意阻塞事件循环 400ms 后每轮仍是 1024 字节上限**，「事件循环饿死导致积压暴涨」的推测不成立 |
| **XON/XOFF** | **[源]** 抢走 Ctrl-S / Ctrl-Q（emacs 反向搜索、readline 引用插入）；不二进制透明；node-pty 要求整条消息匹配。VS Code 2017 年上线、同年删除 |
| **裸丢字节** | **[源]** VT 无分帧、无重同步标记。丢一段会：CSI 参数状态卡住把后续正文吃成参数；未闭合的 OSC 吞掉会话剩余全部；丢掉 `ESC[?1049h` 让 TUI 把整屏画进主缓冲和回滚。只有从权威网格**重新生成**才安全（即上面第 2 条） |
| **调大 `claude-screen.ts` 的 2MB 上限** | 治标；且 xterm.js 自己 50MB 那道门是 `throw` 且**不触发写回调**，调大只会把干净失败变成 ack 死锁 |
| **降低 `scrollback: 20000`** | **[源]** Warp 默认 50,000 行，用户仍会撞到。我们这个值已经偏保守，只是移动端内存问题，不是正确性问题 |
| **整体照搬 mosh 模型** | 要求把完整 ECMA-48 模拟器当作传输单位，永久放弃回滚历史，且排除 sixel/二进制透传 |
| **把 `setFrozen` 从 `visibility:hidden` 改成 `display:none`** | 前者确实**一点渲染都没省**（见下），后者能真省，但 `display:none` 下 `clientWidth` 为 0，任何 fit 都会把列数塌成 2 并毁掉回滚历史。我们的 `fitExact` 已经挡了一道（见二.5），但为了省一点渲染去踩不可逆数据损失，不值 |
| **注入 DECSET 2026（同步输出）** | `RenderService.ts:22` 有 1 秒上限会强制冲刷**并解除**该模式；而且它是布尔不是计数器（`InputHandler.ts:2203`），我们注入的一对会和 CLI 自己用的那对撞车。**接收**它是对的，**注入**不行 |

---

## 三点五、两处关于现有代码的认识修正

**`setFrozen` 并不节省任何渲染。** `xtermEngine.ts:272-275` 用的是 `visibility: hidden`，
而按规范这类元素仍然生成盒子、IntersectionObserver 仍报 `isIntersecting: true`，
所以 xterm 的 `_isPaused` 保持 false、**每一帧照画，只是画完你看不见**。
（真正的遮挡判定是 Observer v2 的 `isVisible`，xterm 没有请求。）

这不算 bug——它的本意就是「重放期间别让你看见半截画面」，遮住即达标。但**别指望它能当节流用**。

**xterm 本来就已经合并渲染了。** `browser/RenderDebouncer.ts:40-54`：所有 `refreshRows`
合并进一个 `requestAnimationFrame`，行范围取 min/max；且渲染成本只随**视口行数**走，
和回滚缓冲多大无关。所以「一秒 60 帧 × 40 行」已经是上限，压制重绘能省的比想象中少。

**唯一受支持的「只解析不重绘」**：`RenderService` 是在 `open()` 里才构造的
（`browser/CoreBrowserTerminal.ts:478`），所有渲染调用都是可选链。所以一个**写过但没 open**
的 Terminal 会零重绘地解析完，`open()` 时只画一帧最终画面。服务端的 `@xterm/headless` 天然如此。
代价：每个 Terminal 只能用一次，形态是「灌进一个新的、然后换上去」。

## 四、本次调研中被推翻的两个判断（记录在案）

1. **「resume 洪流会废掉 GUI 发消息的能力」——大概率错，但两路调研在此打架。**
   一路走真实 PTY 端到端灌 29MB，`broken` 从未触发；另一路称「按真实节奏复现，2.5MB 就永久失败」。
   差别在于喂法：前者经过 node-pty（每轮约 1KB，受 libuv 节流），后者疑似直接循环写入。
   **生产路径就是 node-pty，所以采信前者。**

   但**这不改变要做的事**：`claude-screen.ts:49` 的 `cols > 300` 永久闩死是确定可达的
   （宽屏最大化约 2340px 就够），而且同样不可恢复。所以「不闩死」这个改动无论如何都该做，
   只是它的动机是 resize 那条，不是洪流那条。整块在 `ROOST_CLAUDE_GUI_SEND=1` 之后，默认关。

2. **「重建无头终端是安全的，因为 `classifyClaudeComposer` 很严」——错，而且是 fail-open。**
   **[实测]** 往全空屏只喂一段 composer 区域重绘，返回 `{state:'empty', settled:true}`，
   **会授权注入**。原因是特征串正则接受 `for shortcuts` / `shift+tab`，而这两个字就长在
   composer 自己的页脚里。更糟：拦权限对话框的那行（`claude-screen.ts:9`）是**整屏否定检查**，
   重建后的屏幕没收到过那些行，对话框状态凭空消失。而 Claude 这条路上 `s.dialog` 从不被设置
   （`ai-command-owner.ts:149` 只清零），屏幕是唯一信息来源。

   **替代方案**：不闩死，但只在遇到**已知的整屏边界**（`ESC[2J`、`ESC[3J`、`ESC c`、
   alt-screen 切换）才重新武装；等待期间维持现有的 fail-closed 行为。同一机制也用于 resize 那条。

---

## 五、架构转向：接 RPC（单独立项）

三家的协议都指向同一件事：**让宿主渲染对话，CLI 只负责跑**。这与本应用已经选定的方向
（GUI 为主、TUI 点进去才看）完全一致，且能从根上消灭洪流。

代价要说清：这会动到会话身份、发消息、状态同步三条线。我们现在靠 OSC 777 加抓 transcript
文件，那是「在旁边偷看」；RPC 是「正式对话」。工作量以周计。

**建议先做一个 omp 的原型验证**——`--mode rpc-ui` 是三家里最完整的（连扩展 UI 事件都能路由
到我们自己的界面），且随包带了 TS 客户端。
