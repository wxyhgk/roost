# Codex 状态观察者可行性（2026-09-13）

**结论：可行。** 协议侧完全具备；难点只剩「怎么证明某个 PTY 用的是哪个 thread」，解法是
每个 PTY 起一个私有 app-server socket。状态怎么拿这件事实测后比预想的简单：一条广播通知
`thread/status/changed` 就带齐了 working / blocked / done，既不用订阅也不用轮询（第三节）。

起因：给 Claude / Codex 加了「回复时图标动起来」，Claude 能转而 Codex 不能。查下来不是
动画的问题——daemon 的 `owner.ts` 只认 `claudeHook` / `opencodeEvent` / `qwenEvent`，
**没有 codex**，所以 `activity.agent` 对 codex 会话永远是 undefined。受影响的不只动画：
侧边栏状态点、未读、「在等你回答」角标对 codex 也全是死的。

标注 **[实测]** 的是本轮跑出来的，其余为文档或推断。

## 一、协议侧：完全够用

本机 **codex-cli 0.154.0** [实测]。用 `codex app-server generate-json-schema` 导出了
**这个版本自己的**协议（比查网页可靠），`ServerNotification` 里有 [实测]：

| Codex 通知 | 映射到我们的 `agentStateFor` |
| --- | --- |
| `thread/started` | `session_start` → idle |
| `turn/started` | `prompt_submit` → **working** |
| `turn/completed` | `stop` → done |
| `thread/status/changed` | 见第三节——实测下来**只用这一条就够** |

服务端→客户端的审批请求也齐 [实测]：`item/commandExecution/requestApproval`、
`item/fileChange/requestApproval`、`item/permissions/requestApproval`、
`item/tool/requestUserInput` → `permission_request` / `question_asked` → **blocked**。

也就是说**不需要新增状态机**，现有 `backend/src/session-status.ts` 的事件名一一对得上。

## 二、难点：PTY ↔ thread 的绑定

这一条 `tasks/cli-adapters/codex.md`（09-09）就记着了，官方文档也明说：

> a third observer at the same endpoint cannot definitively associate a TUI instance with
> specific threads without additional context.
> —— thread ID 只回给发起请求的那个客户端；`thread/started` 不透露是哪条连接发起的；
> `clientInfo.name` 标识的是应用类型，不是实例。

而且默认守护进程是**共享**的：控制 socket 固定在
`~/.codex/app-server-control/app-server-control.sock` [实测；`codex app-server daemon start` 起的就是它，本轮实验一直连的这条]。共享端点上
多个终端的 thread 混在一起，正是上面这段说的困境。

**但「without additional context」是可以破的——我们控制启动。**

`codex --remote <ADDR>` 让 TUI 连到指定的 app-server 端点，另有
`--remote-auth-token-env <ENV_VAR>` 走 bearer token [实测，均在 `codex --help` 中]。
于是：

> **每个 PTY 起一个私有的 app-server socket，socket 本身就是绑定。**
> 那条 socket 上只有这一个 TUI，它创建的也就只有这一个 thread——归属不需要猜。

这正是 09-09 那份文档「下一步接线边界」第 1 条提的方向，只是当时没往下做。

## 三、拿到状态的三条路——实测后选第三条

跑了三轮探针（两条连接连同一个 app-server socket），结论和写这份文档时的猜测不一样。

### 实测：通知分两档

| 通知 | 被动连接（没 resume）收得到吗 |
| --- | --- |
| `thread/started` | **收得到** |
| `thread/status/changed` | **收得到** |
| `thread/goal/cleared` 等线程级 | **收得到** |
| `turn/started` `turn/completed` | **收不到** |
| `item/started` `item/completed` `error` | **收不到** |

也就是说：**线程级是广播，turn / item 级是订阅**。协议里没有 `thread/subscribe`，
却有 `thread/unsubscribe` [实测]——订阅是 `thread/start` / `thread/resume` 隐式建的。

### 关键：`thread/status/changed` 本身就够

它的载荷是 `{ threadId, status }`，而 `ThreadStatus` 是 [实测，schema + 实跑]：

```
notLoaded | idle | systemError | active { activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[] }
```

对上我们的状态机，一个不缺：

| ThreadStatus | `agentStateFor` |
| --- | --- |
| `active`，`activeFlags` 空 | working |
| `active` + `waitingOnApproval` | blocked（在等你批准） |
| `active` + `waitingOnUserInput` | blocked（在等你回答） |
| `idle` | done |
| `systemError` | done（出错收尾） |

实跑里被动那条连接确实按时收到了
`{"status":{"type":"active","activeFlags":[]}}`，turn 结束时收到终态 [实测]。

**所以不用订阅、也不用轮询。** 原来以为 blocked 只能靠审批请求或 resume 拿到，是错的——
`activeFlags` 就带着。

### 那两条路各自的下场

- **(a) 订阅**：B 调 `thread/resume` 之后确实收到完整流（`turn/started`、`item/*`、
  `turn/completed`）[实测]。而且**对 live thread 调 resume 没有把它弄坏**：紧接着 A 再发
  `turn/start` 照常成功、照常完成 [实测]。这回答了下面第 3 问——安全，但既然广播已经够用，
  就不必去碰 live thread。
- **(b) 轮询 `thread/read`**：仍然可用（`codex-control.ts` 今天就在用），留作兜底。

## 四、还没定稿的部分

原来列了四件必须实测的事，现在剩两件——**因为这台机器没登录 codex**
（`codex login status` → `Not logged in`），所有 turn 都以 401 收场：

| # | 状态 |
| --- | --- |
| 1. `codex --remote unix://<socket>` 端到端 | **未决**，TUI 要登录后交互驱动才能验 |
| 2. 第二条连接能否收到 turn 通知 | **已决**：turn 级收不到，但线程级状态广播收得到，够用 |
| 3. 对 live thread 调 resume 安不安全 | **已决**：安全，但用不上了 |
| 4. 远程 app-server 的延迟、token 传递 | **未决**，同 1 |

还有一条实测到的工程约束：unix socket 路径受 `SUN_LEN` 限制（macOS 104 字节），
且 `--listen` 的路径**不能经过符号链接**——传 `/tmp/x.sock` 直接报
`socket directory path exists and is not a directory: /tmp`（`/tmp` 是指向 `/private/tmp` 的
链接）。每个 PTY 一个 socket 时，路径要短且要用真实路径。

另外 `active → idle` 这条边没实测到（401 让它走的是 `active → systemError`）；
`idle` 是 `thread/read` 在线程静止时返回的值 [实测]，同一个状态源，但严格说这条边是推断。

## 五、工作量（2026-09-16 已实现，见文末）

和 claude / qwen / opencode 同一量级，不是「加个分支」：

- 启动垫片（对应 `claude-launch.ts`）：起私有 app-server、传 `--remote`、生成并传递 token。
  socket 路径要短（SUN_LEN）且不经符号链接
- 观察者：连上私有 socket，只认 `thread/status/changed`——那条 socket 上只有一个 TUI，
  threadId 不用猜。**不调 `thread/resume`，也不轮询**
- `owner.ts` 加 `codexEvent` 分支 + 输入校验（照 `qwenEvent` 的形状）
- 状态映射、测试
- 版本探测：codex 0.154 才有这套；得走 `probeVersion`，版本不符时静默降级
  （见 `cli-launch-tools.ts` 和
  `issues/2026-09-10-version-probe-timeout-silently-disables-observer.md`）

## 六、做完之后的收益

不只是动画。codex 会话会和 claude 一样拿到：侧边栏实时状态点、未读提示、
「在等你批准/回答」的角标、以及会话活动时间线。现在这些对 codex 全是空的。

---

## 七、实现记录（2026-09-16）

按第五节那份清单做完了，但**有一处偏离**，值得记下来。

**观察者最后放在守护进程里，不在启动垫片里。** 原计划照另外三家的样子写：垫片观察、
把事件推回来。实测挡住了——codex 的 app-server **只认 WebSocket 升级**，往那条 socket 上
直接发换行分隔的 JSON-RPC，一个字节都不回 [实测]。而垫片是写进临时目录的模板字符串，
没有模块解析、拿不到 `ws`，手写一个客户端要百来行帧解析塞进模板。

所以分工改成：垫片起私有 app-server、报 socket 路径、用 `--remote` 接上 TUI；
连接和解析在 `packages/terminal-daemon/src/codex-observation.ts`，那边 `ws` 是一句 import，
而且能正常单测。

落地的三个文件：

- `codex-observation.ts` —— `ThreadStatus` → agent 事件名；只读，initialize 之后不发任何请求
- `codex-launch.ts` —— 垫片；只接管裸 TUI 和 `resume`（roost 自己的恢复配方就是它）
- `owner.ts` 的 `codexObserve` —— 校验照 `qwenEvent`，另外把 socket 路径夹死在守护进程
  自己那个目录里，只认垫片生成的 12 位十六进制名字

两条工程约束按第四节那条写进了代码注释：路径长度（SUN_LEN）和不能经过符号链接。

**仍然没验的**：端到端要这台机器登录 codex。所有 turn 仍以 401 收场，`active → idle`
这条边依旧是推断。代码和单测就位，真机验证等登录。
