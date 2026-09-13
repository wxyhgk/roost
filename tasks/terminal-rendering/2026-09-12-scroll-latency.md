# Claude Code 新全屏渲染器下的滚动手感

日期：2026-09-12。触发：用户反馈「claude 的 TUI 新渲染方式，我们的终端用起来比较卡，感觉是滑动的问题」。

范围：真实 CLI 台架实测、产品代码计算复现、前端改动与本机发布。没有重启终端守护进程，没有向用户正在运行的会话发送输入，没有 resume 任何已有会话。台架内容一律用 `!` 的本地 shell 命令生成，不产生模型请求。

证据级别沿用[前一轮调查](2026-09-11-investigation.md)：**实测**表示本轮在真实 CLI 上测到；**因果测试**表示只改一个变量、其余固定；**产品代码复现**表示直接调用线上代码而非重写一份；**排除**表示测过且不成立。

## 结论

不是带宽问题，也不是我最初怀疑的 xterm.js 视口 bug。是**滚动距离被连打两次折扣，再乘上每格一次网络往返**：

1. Claude Code 全屏渲染器在探测不到滚轮倍率的终端上按 **1 行/格**算。xterm.js 正是这类终端。
2. 我们的 `wheel.ts` 在前面又打了一道 **0.3 触控板阻尼**。
3. 每格滚轮 = 一条独立 WebSocket 消息 = 一次往返 + 一次服务端解析 + 一次归档追加。

合起来：触控板一次轻扫只滚到原生的 **23%–30%**，而且要等一个 RTT 才开始动。本机往返 1–17ms 感觉不明显，FR 那条链路[自测中位 330ms](2026-09-12-next-experiments.md#当前基线)，就是「滑一下，等三百毫秒，爬两行」。

鼠标滚轮基本不受影响（96%–99%），因为阻尼只命中 `|deltaY| < 50` 的事件。**这是触控板专属问题**。

## 新渲染器做了什么

`/tui fullscreen`，v2.1.239 起对新用户默认开启（本轮台架用的 CLI 是 2.1.269）。和 classic 的差别不是画得快慢，是**绘制模型换了**：

| | classic | fullscreen |
| --- | --- | --- |
| 画布 | 终端原生 scrollback，向下追加 | 备用屏缓冲区（`?1049h`），像 vim |
| 滚动归谁 | 终端自己滚 | **应用内滚动**，要开鼠标上报 |
| 更新粒度 | 重画整块消息 | 帧调度 + diff，只发变化的单元格 |
| 撕裂控制 | 无 | 同步输出 DEC 2026，`CSI ?2026 h/l` 包住每帧 |

关键后果是第二行：**滚动从本地操作变成了往返操作**。classic 下滚轮由 xterm.js 自己消费，零往返；fullscreen 下每一格都要送到 PTY 那头再把新一屏拿回来。

官方说明：<https://code.claude.com/docs/en/fullscreen>

## 排除掉的三个假设

### 1. xterm.js #5801（2026 同步块里的 ED2 拽视口）—— 不成立（因果测试）

最初怀疑的是[这个 issue](https://github.com/xtermjs/xterm.js/issues/5801)：PR #5453（v6.0.0）加了 DEC 2026，但只实现了「延迟渲染」那一半，没实现「抑制 erase 的视口副作用」，于是同步块里的 `\x1b[2J` 仍会把 `viewportY` 拽回底部。我们两端都在 `@xterm/xterm` / `@xterm/headless` 6.x 上，看起来正中靶心。

实测：**整条流里 `?2026h` 出现 0 次，连 `CSI ?2026$p` 的支持性探测都没发过。**

因果测试确定了门槛在哪——唯一变量是回不回答 XTVERSION（`CSI >0q`）：

| XTVERSION 应答 | `?2026$p` 探测 | BSU |
| --- | --- | --- |
| 不回答（xterm.js 现状） | 0 | 0 |
| `roost-ai-coding-web 1.0` | 3 | 15～21 |
| `ghostty 1.2.0` | 3 | 17 |

BSU 数就是画了几帧，随每次运行的时序波动；有意义的是 0 与非 0，以及探测发不发。

xterm.js 只回一个 DA1 `CSI ?1;2c`，不答 XTVERSION、不答 OSC 11、不答 kitty 键盘查询。CLI 据此把它当未知终端，直接放弃同步输出。所以 #5801 在我们这里**根本没有被触发**；备用屏也没有 scrollback 可拽。

副作用值得单独记：我们因此**也拿不到同步输出**，每次滚动的回包被拆成 2–3 个 chunk，各自落地即绘制。这条见下面的「没有做」。

### 2. 流量 / 刷屏 —— 不成立（实测）

`!seq 1 30000` 的流式输出，从头到尾：

| | 总回传 | chunk 数 |
| --- | --- | --- |
| fullscreen | 6,608 B | 27 |
| classic | 14,067 B | 33 |

fullscreen **更省**，因为它只渲染可见消息。前端解析这一整轮共 2.1 ms。滚动本身每格 440–800 B。量级上完全不构成瓶颈。

### 3. `?1003h` 鼠标移动洪水 —— 不成立（实测）

全屏渲染器会开 `?1003h`（上报所有移动），前端的点击与移动上报由 xterm.js 自己发，看起来像个洪水源：

```
静止 2s               : 0B / 0 chunk
划过整屏 60 个移动事件 : 36B / 1 chunk
输入框附近抖动 60 次   : 0B / 0 chunk
```

CLI 只在 hover 命中变化时才重画。下行没有问题。**上行**仍然是每次移动一条转义序列，本机可忽略，弱网下是另一件事，本轮没测。

## 根因的两个乘数

### 一格滚轮只滚一行（实测）

用 `seq` 的行号当标尺，读 headless 缓冲区的可见最小行号做差：

```
滚轮  1 格 -> 1965 → 1964    1 行   1.00 行/格   回传 743B
滚轮  3 格 -> 1962 → 1959    3 行   1.00 行/格   回传 440B
滚轮 10 格 ->            19 行   1.90 行/格   回传 1332B   ← 快甩才有加速
滚轮 30 格 ->           127 行   4.23 行/格   回传 2332B
```

慢手势完全没有加速。官方文档明确说 xterm.js 系终端（VS Code 内置终端同款）一格就是一个事件、没有倍率，而 CLI **检测不出来**，所以建议用户自己设 `CLAUDE_CODE_SCROLL_SPEED`。实测设成 3 之后变成 3.00 行/格（快甩 3.90 / 5.27）。

### 我们自己又打了一道 0.3（产品代码复现）

`wheel.ts` 原本无条件复制 xterm 的触控板阻尼。直接调用产品代码算真实手势：

| 手势 | 原生行数 | 改前发出 | 改后发出 |
| --- | --- | --- | --- |
| 触控板 轻扫 420px | 24.7 | 7 格（28%） | 24 格（97%） |
| 触控板 慢推 150px | 8.8 | 2 格（23%） | 8 格（91%） |
| 触控板 大力扫 1200px | 70.6 | 21 格（30%） | 70 格（99%） |
| 鼠标滚轮 3 格 | 17.6 | 17 格（96%） | 17 格（96%） |

那 0.3 确实来自 xterm——在 `xterm.mjs` 的 `Viewport._getLinesScrolled` 里，用于**它自己的本地滚动**：一帧能重画好几次，滚慢一点是顺滑。而 TUI 自绘滚动是「一格 → 一次往返 → 重画一屏」的离散动作，两条路径的取舍相反。xterm 另外给本地滚动留了 `scrollSensitivity` 可以补偿，我们这条路径上没有对应物。

## 已实现

`frontend/src/features/terminal/wheel.ts`：

- [`wheelTicks`](../../frontend/src/features/terminal/wheel.ts) 增加 `damp` 参数。默认 `true` 保持与 xterm 本地滚动一致；`attachHostWheel` 在转发给 TUI 的路径上传 `false`。
- `attachHostWheel` 改为**按 animation frame 合并**：一帧内攒下的行数带符号累加（中途反向自动抵消），合成一条序列发一次，而不是每个 DOM wheel 事件发一条。一次触控板轻扫从约 20 次往返降到 1–2 次。宿主没有 rAF 时退回 16ms 定时器。
- 非转发路径把 carry 清零，进 TUI 时不再带着普通 shell 那段的半行零头。

`frontend/tests/terminal-mouse.test.ts` 新增 5 条：阻尼开关两种取值、一次手势合并成一条、同帧反向抵消、合并窗口内 TUI 退出则丢弃、普通 shell 下不拦截滚轮（不 `preventDefault`，否则 xterm 滚不了自己的历史）。

**没有采用环境变量方案。** `CLAUDE_CODE_SCROLL_SPEED=3` 实测有效（1.00 → 3.00 行/格），改 [terminal-runtime 构造 env 的那一处](../../packages/terminal-runtime/src/index.ts)即可全局生效，一行代码。但它对触控板和鼠标滚轮同时生效：触控板从 28% 抬到 85%，鼠标滚轮会被推到 290%，太快。不对称的问题要在不对称的那一层修，所以它只作为验证手段。

## 没有做

- **答 XTVERSION 换同步输出。** 实测报自己的真名一样生效，不需要冒充别的终端。但一旦 CLI 开启 2026，classic 渲染器下就会踩上 #5801：用户往上滚时被 ED2 拽回底部。要先有 BSU..ESU 期间的 viewport 守卫（把 erase 引起的 `viewportY` 变更缓存到 ESU 再提交），再开这一项。另外实测它对滚动的收益有限（每次滚动提交绘制 3 次 → 2 次），主要价值在大面积重绘时的原子性。
- **上行流控。** 移动上报每次一条序列，弱网下的实际影响没测。
- **FR 现场验证。** 本轮全部在本机完成；远端只沿用了上一轮记录的 RTT。

## 重复验证

四个探测脚本共用 [`probe-cli-harness.mts`](probe-cli-harness.mts)：真实 CLI ↔ node-pty ↔ `@xterm/headless`。用 headless 当终端而不是自己伪造应答，是因为**能力探测的答案决定 CLI 发什么**——手写应答只会测到我们以为的终端，测不到前端真正表现出的那一个，前端用的就是这同一个解析器。每次在独立临时目录起新会话，不碰工作区数据库、不连守护进程。

```sh
node --import tsx tasks/terminal-rendering/probe-scroll-rate.mts          # 行/格；带参数试 SCROLL_SPEED
node --import tsx tasks/terminal-rendering/probe-sync-output.mts          # 现状：0 BSU
node --import tsx tasks/terminal-rendering/probe-sync-output.mts "roost-ai-coding-web 1.0"
node --import tsx tasks/terminal-rendering/probe-mouse-motion.mts         # 移动不造成回流
node --import tsx tasks/terminal-rendering/probe-wheel-gesture.mts        # 纯计算，不起 CLI
node --import tsx tasks/terminal-rendering/probe-wheel-gesture.mts damp   # 同上，旧行为
```

## 验收与发布

前端 321/321 通过。后端 265 通过 / 1 失败 / 8 跳过，与本次改动前安装目录里记录的 `~/.local/share/diy-ai-coding-web/deployment/verify-node26.log` 逐项一致；那一个失败是 `backend/tests/watcher-boundaries.test.ts` 在 Node 26 上 `mock.module is not a function`，README 记录的验证版本是 Node 25.9.0。前端生产构建与模块边界检查通过。

本机发布：`main-CxI3XGEa.js` → `main-CG6L0TD0.js`，`publish-assets` 新增 3 个、复用 9 个。核对过新入口 200 + immutable、上一版入口仍可取、不存在的 hash 返回 404 而不是回退 HTML。index.html 是 `no-store`，普通刷新即生效。守护进程与在跑的终端会话 PID 未变。

### 两个会浪费时间的环境陷阱

跑测试前值得先确认，否则会看到和代码无关的红：

- `packages/terminal-daemon/tests/claude-launch.test.ts` 在**从本产品的网页终端里跑**时必然失败：`ROOST_CLAUDE_OBSERVING=1` 被 `process.env` 带进测试，shim 正确地拒绝重复注入 `--plugin-dir`，于是钩子一个都不触发。`env -u ROOST_CLAUDE_OBSERVING` 后 5/5。
- `backend/tests/auth-config.test.ts` 的「拒绝公开权限的密码文件」在 `umask 077` 下必然失败：测试写的 `mode: 0o644` 被掩成 `0o600`，文件根本不公开，于是没有该被拒绝的东西。`umask 022` 后通过。同一原因也影响 `backend-hardening.test.ts` 的原子保存用例。
