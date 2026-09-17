# 守护进程原地换二进制（handoff）：可行性实测

> **后续（2026-09-16）**：又跑了四路调研，结论是**不建议走 execve**，详见
> [../../research/daemon-handoff-findings.md](../../research/daemon-handoff-findings.md)。
> 这份文档正文保持原样（它是当时的事实），但其中第 4 条待办里的猜测
> 「监听 fd 同样在没有 CLOEXEC 时活过 execve」**已被实测推翻**——libuv 开的一切都带
> CLOEXEC，TCP 和 UDS 的监听 fd 都是 EBADF。另外新测出一条当时没想到的：
> **低号 fd 活不过第二次交接**，而且失败是静默的。

**结论：可行，而且不需要 fork node-pty。** 下面每条都是在这台机器上实测的，不是推断。

## 为什么要这个

改了守护进程就得重启，而重启会掐掉它拥有的所有 PTY——包括正在用的 AI CLI 会话。
2026-09-16 加尺寸回声那笔就卡在这里：能力位要守护进程重启才生效，而重启会当场结束
正在进行的对话。

tty7 有对应物（`FEATURE_HANDOFF`，`crates/tty7-core/src/daemon/handoff.rs`）：用 `execve`
原地换掉自己的二进制映像，PID 不变，PTY 和跑在上面的东西全部留着。他们只在 `cfg!(unix)`
下广播这个能力，因为 Windows 没有 `execve`。

## 实测结果

Node 有 `process.execve`（v25.9 / v26.8 上都有；roost 守护进程用的是 v25.9）。

起一个 `node-pty` 的 PTY，记下 `p.fd` 和子进程 pid，然后 `process.execve` 成另一个脚本，
把 fd 和 pid 用环境变量带过去。新映像里：

| 问题 | 结果 |
|---|---|
| master fd 还开着吗 | ✅ 开着——**没有 CLOEXEC** |
| 子进程还活着吗 | ✅ 活着，PID 不变所以它仍是我们的孩子 |
| 还能读吗 | ✅ `new tty.ReadStream(fd)` |
| 还能写吗 | ✅ `fs.writeSync(fd, ...)` |
| 还能改尺寸吗 | ✅ `pty.native.resize(fd, cols, rows)` |

最后一条是关键：`node-pty` 的 `resize` 是原生的，接管之后已经没有 `IPty` 对象了。但它把
原生入口暴露在 `require('node-pty').native` 上（`fork/open/resize/process`），**直接对裸
fd 调 `native.resize` 是生效的**——实测子进程 `stty size` 从 `24 80` 变成 `30 100`。

踩过的两个坑，都是测试方法的错，不是能力的限制：

- `net.Socket({fd})` 对 PTY 报 `ERR_INVALID_FD_TYPE: Unsupported fd type: TTY`。要用
  `tty.ReadStream`。
- 在**同一个进程里**一边留着 node-pty 对象、一边用 `tty.ReadStream` 读同一个 fd，读不到
  东西——两个读者在抢。真实接管场景里 node-pty 随 execve 一起没了，不存在这个竞争。
  第一次这么测得出了「不可行」的错误结论。

## 还没做的（真实实现要解决的）

1. **状态怎么过去。** 哪个 fd 对应哪个 session/instance、cwd、cli 是什么。tty7 用一个
   `Carried` 结构体（`pane.rs:1087-1108`）。roost 可以走环境变量或一个临时文件。
2. **重放环怎么过去。** roost 的滚动历史一部分在内存、一部分在 SQLite。SQLite 那半天然
   活着；内存那半要么带过去，要么接受重建。
   （tty7 的 `Carried` 带了整个环，但**漏了 modes** —— `adopt` 里是 `TerminalModes::default()`，
   所以他们 handoff 之后会丢一次「环头部被切掉的 mode 补偿」。抄的时候别抄这一点。）
3. **runtime 需要一种「接管来的会话」形态**：拿 fd + tty 流 + `native.resize` 拼出和
   `IPty` 一样的接口。
4. **监听 socket**。守护进程的 IPC socket 也要么活过去、要么重建——监听 fd 同样在没有
   CLOEXEC 时活过 execve，没测。
5. **只能是 POSIX**。`process.execve` 在 Windows 上没有，和 tty7 只在 unix 下广播
   `FEATURE_HANDOFF` 是同一个限制。roost 支持 Windows，所以这要当成一个**能力**，不是
   一个假设。

## 怎么复现这次实测

两个脚本，A 起 PTY 然后 execve 成 B，B 里验四件事。要点：脚本得放在仓库根下跑，
不然 `require('node-pty')` 解析不到。
