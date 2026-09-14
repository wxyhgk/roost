# Codex 状态观察者可行性（2026-09-13）

**结论：可行，但不是接一根线的事，是一整条集成。** 协议侧完全具备；难点全在「怎么证明
某个 PTY 用的是哪个 thread」，而这一条有解法，只是需要实测才能定稿。

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
| `thread/status/changed` | 兜底校正 |

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
`~/.codex/app-server-control/app-server-control.sock` [实测，当前未运行]。共享端点上
多个终端的 thread 混在一起，正是上面这段说的困境。

**但「without additional context」是可以破的——我们控制启动。**

`codex --remote <ADDR>` 让 TUI 连到指定的 app-server 端点，另有
`--remote-auth-token-env <ENV_VAR>` 走 bearer token [实测，均在 `codex --help` 中]。
于是：

> **每个 PTY 起一个私有的 app-server socket，socket 本身就是绑定。**
> 那条 socket 上只有这一个 TUI，它创建的也就只有这一个 thread——归属不需要猜。

这正是 09-09 那份文档「下一步接线边界」第 1 条提的方向，只是当时没往下做。

## 三、拿到状态的两条路

### (a) 订阅 —— 更实时，但有风险

文档称 `thread/start` / `thread/resume` 会「automatically subscribe you to turn/item
events for that thread」。**协议里没有独立的 `thread/subscribe`** [实测，
`ClientRequest` 全量方法里没有 subscribe/watch/listen]。

风险在于：现有 `codex-control.ts` 的注释写着它**刻意不调用** `thread/start`、
`thread/resume`、`turn/start`、`turn/steer`——对一个 TUI 正在驱动的 live thread 调
resume 会不会干扰它，没人验证过。

### (b) 轮询 —— 更稳，够用

`thread/read {includeTurns:false}` 返回 `status: 'idle' | 'active'`，而
**`codex-control.ts` 今天就在用它**（`inspect()`），已经被认定为安全的只读操作 [实测，
见该文件 72–76 行]。`active` ↔ working，`idle` ↔ done。

代价是延迟和一点轮询开销。对「图标转不转」这种用途，1 秒一次足够；对「在等你回答」
的角标，`thread/read` 给不出 blocked——那还是得靠审批请求的通知或订阅。

**建议先做 (b) 打通链路，再用实验决定要不要升级到 (a)。**

## 四、必须实测才能定稿的四件事

文档答不了，只能跑：

1. `codex --remote unix://<我们起的 socket>` 端到端能不能用，TUI 行为和直接启动是否一致
2. 同一条 socket 上的**第二条连接**，在不调用 resume 的情况下能不能收到 TUI 那条 thread
   的 turn 通知
3. 对 live thread 调 `thread/resume` 是否安全（现有代码刻意回避的那件事）
4. 远程 app-server 对 TUI 的延迟影响、以及 token 怎么在垫片里安全传递

第 2 条是关键分叉：能收到就走订阅，收不到就只能轮询。

## 五、工作量

和 claude / qwen / opencode 同一量级，不是「加个分支」：

- 启动垫片（对应 `claude-launch.ts`）：起私有 app-server、传 `--remote`、生成并传递 token
- 观察者：连上私有 socket、认 thread、把 turn/审批事件转成 `codexEvent` 发回 daemon
- `owner.ts` 加 `codexEvent` 分支 + 输入校验（照 `qwenEvent` 的形状）
- 事件名映射、测试
- 版本探测：codex 0.154 才有这套；得走 `probeVersion`，版本不符时静默降级
  （见 `cli-launch-tools.ts` 和
  `issues/2026-09-10-version-probe-timeout-silently-disables-observer.md`）

## 六、做完之后的收益

不只是动画。codex 会话会和 claude 一样拿到：侧边栏实时状态点、未读提示、
「在等你批准/回答」的角标、以及会话活动时间线。现在这些对 codex 全是空的。
