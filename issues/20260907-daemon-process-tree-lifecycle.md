# 开发服务递归停止导致 daemon 与 PTY 退出

- 日期：2026-09-07
- 状态：启动方式已修正，测试通过；本次丢失的进程状态不可恢复
- 发现方式：主题适配部署时，代理停止了 concurrently 父进程，随后核对 daemon 和 PTY 身份发现变化

## 影响与证据

重载前 daemon PID 为 `41016`；两个已有 PTY 的 PID 为 `41068`、`41257`。重载后这三个进程均不存在，新 daemon 为 `13671`。这违背了“只重载网关保留终端”的预期，是代理执行停止操作造成的运行中断。

会话 ID 与工作区记录保留；之后核对两个会话的 shell PID 为 `15347`、`16083`。这些是新进程，不能表述为恢复了旧进程、旧任务或内存状态。未自动重新执行用户 CLI 命令。

## 原因

`npm start` 使用 `concurrently --kill-others`，其实现依赖 `tree-kill`。原启动器直接从网关 `spawn(..., { detached: true })` 创建 daemon。`detached` 建立独立进程组，但在网关仍存活时并不会移除父子关系；递归枚举后代的停止工具仍能触达 daemon 和 PTY。

之前的网关 SIGTERM/SIGKILL 测试只覆盖直接停止网关进程。直接父进程退出时，子进程先被重新托管，所以该测试无法覆盖递归进程树清理。

## 修复

- 新增 `packages/terminal-daemon/src/launch.mjs`，由短生命周期中间进程生成实际 daemon 后退出。
- 网关继续等待原来的 socket handshake；不改变持久化目录、凭据传递或终端接口。
- owner 测试增加祖先链检查：启动完成后，daemon 不得仍是启动网关的后代。
- 实际网关重启与 SIGKILL 的 PID/instance/cursor 保留测试继续通过。

修复对新启动的 daemon 生效；已经由旧代码启动、仍有父子关系的 daemon 不会凭空改变进程拓扑。本次后续采用直接停止网关进程的方式，核实当前 daemon `13671` 的 PPID 已为 `1`，再启动网关，daemon 保留。

## 验证与限制

- `npm test --workspace @roost/terminal-daemon` 通过。
- `backend/tests/daemon-restart.test.ts` 通过。
- 最终 `npm run verify` 全部通过。
- 新网关 HTTP 与 `appearance-owner` 消息可用，第一帧保持 `hello`。
- 新增测试证明 daemon 脱离网关后代树；不是本次已退出的旧 PTY 可以恢复的证明。
