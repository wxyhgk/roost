# 守护进程重启：改了什么，重启后验什么

日期：2026-09-12。写在重启**之前**——这次重启会结束守护进程持有的全部 PTY，
包括当时正在写这份文档的那个会话，所以验证清单必须留在仓库里而不是留在终端里。

重启前的现场：daemon PID 41397，4 个会话
（`s_gfl06lugvg` claude / `s_8bdo2flx5g` omp / `s_x3t78dbba4` / `s_gnc270jk9q`）。

## 正确的重启方式

三个服务由 launchd 托管（`~/Library/LaunchAgents/com.diy-ai-coding-web.*.plist`，
`KeepAlive=true`）。**不要 `kill` 再自己起**：kill 之后 launchd 会立刻拉起来，手动那个
再启一遍就和它抢端口，日志里留下 EADDRINUSE，谁赢看运气。这个坑本轮踩过一次。

```sh
launchctl kickstart -k gui/$(id -u)/com.diy-ai-coding-web.terminal   # 守护进程（会断所有终端）
launchctl kickstart -k gui/$(id -u)/com.diy-ai-coding-web.backend    # HTTP 后端（不断 PTY）
```

## 这次重启让哪些改动生效

| 改动 | 位置 | 实测收益 |
| --- | --- | --- |
| IPC 按行读取去掉 O(n²) | `packages/terminal-daemon/src/wire.ts` | 3.5MB 帧：16KB 分片 51.3ms → 2.2ms（24×），且不再随分片变小而恶化 |
| SQLite 落盘延迟尾巴 | `packages/workspace-store/src/database.ts` | 330 次 512KB 写入的 max 7838us → 846us |
| hook 连接不再收输出广播 | `packages/terminal-daemon/src/owner.ts` | 修正性问题，见下 |

hook 那条不只是省开销：CLI 的 hook 脚本连上来只为报一个事件，却和网关一样收到
每个终端的每一块输出广播，而它自己的读缓冲有硬上限（opencode 只有 64KB）——终端一
刷屏缓冲就被顶满，脚本把自己的 socket 掐掉，**它自己那条回复也就丢了**。

## 重启后必须验的三件

### 1. 终端历史能正确恢复（唯一有风险的一条）

`synchronous = NORMAL` 让提交不再每次 fsync，改为 checkpoint 时落盘。掉电可能丢掉
最后几批终端输出——这类数据本来就只是尽力保留（守护进程被强杀同样会丢），但**如果
以后有必须落盘才算数的数据写进同一个库，这一行要重新评估**。

验法：重启后开一个新终端，跑点有输出的命令，刷新页面，看输出是否完整回来；
再把页面关掉重开一次。

### 2. 各 CLI 的 hook 仍然通

改动按方法名把 `claudeHook` / `opencodeEvent` / `qwenEvent` 三个方法的连接移出广播集。
网关一个都不调这三个方法，所以对它透明；但要确认 CLI 侧的会话识别没退化。

验法：在终端里起一个 Claude 或 OpenCode 会话，看侧栏能否认出 CLI、对话能否关联上。

### 3. 终端输入不串会话

`handles.ts` 这轮被拆过（状态与延迟搬去 `status.ts`），`claimTerminalSession` 的清理
逻辑抽成了 `releaseRegistrations()`。它守的是「一次新的挂载接管整个会话」。

验法：开两个终端来回切，在各自里打字，确认不会打进对方。

## 出问题怎么退

现在有 git 了。

```sh
git log --oneline          # 找到这几条改动之前的提交
git revert <commit>        # 或 git checkout <commit> -- <具体文件>
launchctl kickstart -k gui/$(id -u)/com.diy-ai-coding-web.terminal
```

单独回退某一项也行，三条互不依赖：

- IPC 读取：`packages/terminal-daemon/src/wire.ts`（有 `tests/wire.test.ts` 6 条护着）
- SQLite pragma：`packages/workspace-store/src/database.ts` 那一行
- hook 广播：`packages/terminal-daemon/src/owner.ts` 的 `ONE_SHOT_METHODS`

## 还欠的验证

分子编辑器那两件一直没验：关掉再打开是否秒开（长命 iframe）、
「送到终端」是否走通（indigo 的 render → PNG → 上传 → 插进 CLI）。
仓库根目录的 `benzene-wasm-check.mol` 是为这个留的，未跟踪状态，验完可以删。
