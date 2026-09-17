# 守护进程热交接：四路调研的实测结论（2026-09-16）

**结论：execve 那条路不建议走。** 不是因为做不出来，是因为它的失败**全都是静默的**，
而且其中最要命的一条只在**第二次**交接时才发作。

四路分别查的是：监听 socket 能不能活过 execve、tty7 的实现、Node 的 execve 语义、
别人怎么做无损升级。这份只记**实测**和由实测直接推出的结论；tty7 源码的细读在
`tty7-lessons.md`，可行性的第一轮在 `tasks/daemon-handoff/feasibility.md`。

---

## 一、最要命的一条：低号 fd 活不过**第二次**交接

Node 启动时 libuv 会调 `uv_disable_stdio_inheritance()`：从 fd 0 往上逐个设
`FD_CLOEXEC`，**前 16 个无条件设**，之后一直走到第一个已关闭的 fd 才停。

于是：

- node-pty 的 master 通常落在 fd 11 / 12。它是**启动之后**才开的，所以第一次交接没事。
- 交接之后，那个 fd 变成了「启动时就存在」——新映像起来时被打上 CLOEXEC。
- **第二次交接它当场 EBADF。**

三连跳实测：

```
[HOP0] pty master fd=12 childpid=98595
[HOP1] pty fd 12 -> ALIVE   write to pty master: OK
[HOP2] pty fd 12 -> DEAD (EBADF) | pty child pid 98595 alive=true
```

**子进程还活着，master 没了。** 没有异常、没有日志，`process.kill(pid, 0)` 还继续答
alive。用户看到的是「这个终端卡住了」。

精确规则（逐个验证过）：libuv 在**第一个「fd > 15 且已关闭」的位置**停下，那之后的 fd
才安全。继承 17/18/19 全活；继承 3/4/5 全死；继承 16/17 两个都死（16 开着所以它继续往
上走）。和 fd 类型无关，只和编号与连续性有关。中间夹 `sh` 而不是 node 则全活——
**是 libuv 干的，不是 execve(2) 或内核。**

**tty7 碰不到这个坑**（Rust，不经过 libuv）。这是「抄别人的方案」最危险的那类差异：
它在对方的语言里根本不存在，所以对方的代码和文档里都不会提。

## 二、失败模式在我们这个版本上是 abort，不是抛异常

```
v25.9.0（守护进程用的）  → abort，退出码 134，catch 块从没执行
v26.8.2                 → 捕获到 ENOENT，进程继续，退出码 0
```

两版的 `process.execve` **JS 包装层逐字节相同**，但 abort 发生在 C++ 的
`node::Execve` 里。所以「读 JS 实现一样就以为行为一样」会得出错误结论——这一条是
本轮两份报告互相矛盾之后，拿守护进程自己那个二进制复测出来的。

含义：**在当前运行时上，execve 失败没有回滚点。** 一次路径写错就是全部 PTY 陪葬。
Node ≥ 26.1 才改成抛异常。

## 三、fd 的 CLOEXEC：libuv 开的一切都带，只有原生插件和 stdio 不带

活不过 execve：`fs.openSync` 的普通文件、`createWriteStream`、TCP 和 UDS 的监听 fd、
已 accept 的连接、客户端连接、`spawn` 的管道、`node:sqlite` 的三个 fd。

活得过：node-pty 的 master、stdin/stdout/stderr。

**纯 JS 里没有办法清掉这个标志。** Node 没有 `dup` / `dup2` / `fcntl`
（nodejs/node#41733 仍开着）。`/dev/fd/N` 的 dup 花招在 macOS 上对 socket 能 dup 成功，
但 `fs.openSync` 自己又加 `O_CLOEXEC`，新 fd 一样死。要清只能上原生模块。

**两条直接后果：**

1. `tasks/daemon-handoff/feasibility.md` 第 4 条待办里的猜测——「监听 fd 同样在没有
   CLOEXEC 时活过 execve」——**实测是错的**。TCP 和 UDS 都是 EBADF，连 backlog 都在
   内核里没了。
2. **tty7 那个「匿名文件」的做法我们做不到。** 他们把交接数据写进临时文件、写第一个
   字节之前就 unlink、只靠 fd 传过去，理由是那里面装着用户的终端输出。我们的 fd 过不去，
   所以只能是盘上一个有名字的文件——那条隐私论证对我们不成立，得自己做决定。

## 四、`process.on('exit')` 不触发

`exit`、`beforeExit`、`uncaughtException` 在 execve 时**一个都不跑**（实测：钩子里
append 的日志文件根本没被创建）。

**所有「退出前 flush」的逻辑会被完整跳过，而且没有任何提示。** 交接路径必须有一条
独立的、显式同步的 flush，不能复用退出路径。

在途的异步操作同样全丢：`setTimeout` / `setImmediate` / `nextTick` / microtask 都不跑；
排了 10 MiB 的 `createWriteStream` 实测只落下 262144 字节，**静默丢掉 9.7 MB**。

最阴的一条：`fs.writeFile(path, data, cb)` 不 await 就 execve，**文件被创建出来但是
0 字节**——`open(O_CREAT|O_TRUNC)` 已经在线程池里跑完了，写还没跑。如果目标文件原来
有内容，**结果是把它截断成空**。`fs.appendFile` 同样。

同步 API（`writeFileSync` / `appendFileSync`）完整落下。

## 五、其余实测，各一条

- **backlog 里没被 accept 的连接会被静默丢掉。** 客户端的 `connect()` 成功返回过、
  `send()` 也没报错，但那个请求从来没被任何人读到。
- 客户端看到的是 **`hadError=false` 的干净 FIN**，不是 reset。把「干净断开」当成
  「服务端正常退出了」的重连逻辑不会重连。
- **重新 bind 必须先探活再 unlink**：先 bind，EADDRINUSE 就 connect 探一下——连得上
  说明有健康的守护进程在听，放弃；ECONNREFUSED 才是陈旧文件。无脑 unlink 会把别人的
  路径偷走。重新 bind 之后 **`chmod 0600` 要重做**，新 inode 不继承权限。
- **execve 的 argv 必须原样带上 `--import tsx`。** 守护进程是这么起的（plist 里的
  `ProgramArguments`）：`node --import tsx deploy/terminal-owner.mts`。漏掉那两个参数
  就是新映像根本起不来，而那一刻旧映像已经没了，PTY 全丢。**写死成常量，别从
  `process.argv` 抄**：execve 之后 argv 会被改写，抄一次漂一次。
- 空窗：裸 node execve → 重新监听约 30ms，带模块加载约 65ms。**这个数字偏小，别拿它
  做设计依据。** 同一台机、守护进程那个 v25.9.0，boot 到第一行 JS：裸 node 33–52ms，
  `node --import tsx` 56–83ms（tsx 本身约 +25ms）。而 tsx 还要在 import 时逐个转译
  `terminal-owner.mts` 整条依赖树，那部分没测、多半是大头，再加上 SQLite 打开和
  `ensureCodexRuntime`。**真实空窗按几百 ms 估，不是几十 ms。** 所以「先 bind 再做重活，
  让客户端连上等着而不是被 ECONNREFUSED 拒掉」这条比原先估计的更值得做。
- **`node:sqlite` 是干净地死掉**，不是「活着但状态坏了」：未提交的事务正确回滚，
  `integrity_check: ok`，重开就能写。这条是好消息。
- **被接管的子进程会变僵尸**，而且 Node 没有 `waitpid`：`process.kill(pid, 0)` 对僵尸
  答 alive——**不能用它判会话是否还活着**，要用 master 的 EOF。
- **node-pty 漏了额外的 fd**：master 有两个、slave 一个，都不带 CLOEXEC。**slave 一直
  开着会让 PTY 的 EOF 语义失效**（子进程退完 master 也读不到 EOF）——而「用 EOF 判退出」
  正是上一条要求的做法，两条撞在一起。
- **Windows 上 `typeof process.execve === 'function'` 是 true**，调用时才抛
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`。**不能用它做特性探测**，要判 `process.platform`。

## 六、别人怎么做的（对照，不展开）

- **tmux / screen**：没有服务端热重启，协议版本不匹配就拒绝连接。反面教材。
- **zellij**：做的是「新 client 连旧 server」的前向兼容——绕过去，不是解决：旧 server
  继续跑旧代码，改动压根不生效，只是不丢会话。
- **socket activation（systemd / launchd）**：只保监听 socket，**不保进程，PTY 照死**。
  对我们的核心问题正交。而且 launchd 那套是 XPC 的 C API，Node 拿不到，要原生 addon。
  **划掉。**
- **nginx 热升级**：保 listen fd，进程不保，两套 worker 同时 accept。这套时序套不进来
  ——PTY 所有权是独占的，两个进程没法同时读一个 master fd。但它那个「不可逆之前留一个
  人能介入的验证点」值得抄。
- **Herdr**（同品类，terminal multiplexer + AI workspace）：**也没选 execve**，选的是
  SCM_RIGHTS 传 fd。但 Node 的 `net` 不支持 SCM_RIGHTS，nodejs/node#53391 已
  closed as not planned。它那句总结值得记：*「它不搬子进程，它搬的是那些进程已经连着的
  终端的所有权。」*

## 七、三条独立的轴，别混成一维

1. **保进程**（execve）—— 唯一同时保住 fd、父子关系、内存态的。不可逆，POSIX only，
   而且上面那一整串静默失败都在这条路上。
2. **保 fd**（SCM_RIGHTS / 继承）—— 有 commit 点、能回滚，但丢父子关系（退出码没了）；
   Node 里要原生 addon；Windows 上 HPCON 明确不能 `DuplicateHandle`。
3. **保状态让对端重连**（mosh / 我们的重放环）—— 最便宜最可移植，但保不住 PTY 里跑的
   那个进程，而那恰恰是我们唯一想保的东西。

第四条正交轴——**保监听 socket**——对我们无关紧要，网关本来就带重试。

## 八、倾向

**holder 进程**：把持有 PTY 的那半冻住（起 PTY、读写字节、resize、退出码，外加一段
**原始字节环**），天天改的那半（协议、重放解析、agent 观察、journal、peer）放到可以
随便重启的进程里。

- 上面那一整串静默失败一条都不存在——没有 execve，就没有 CLOEXEC、没有被跳过的 exit
  钩子、没有在途写丢失、没有僵尸。
- **唯一在 Windows 上也成立的。** ConPTY 本来就设计成「所有 client 退完才释放」。
- 父子关系保住，退出码正常。
- 没有「两个所有者」的窗口。

**字节环要放在 holder 里**，这一条是这轮新加的：否则守护进程一重启，内存那半重放环
还是丢，「无损」就打折了。holder 不解析，只留最近那段原始字节。

代价：每会话多一个进程；字节多一跳；holder 的协议必须**小到能真正冻住**（它的升级答案
是「不升级」，旧 holder 带着旧会话自然消亡）；孤儿 holder 要回收。

---

## 九、已经写过又删掉的那块

`adoptPty`（`packages/terminal-runtime/src/adopted-pty.ts` 及其测试）在这轮调研之前就写完
并提交了，commit `bbfd3dc`。它拿一个裸 fd 加一个 pid 拼出 runtime 用到的那一小块
`IPty`，用 `native.open()` 开真 PTY 对测过，六条全绿。

**调研之后删掉了**，两个理由：

1. 方向没定，而它只服务于 execve 那条路。留着是死代码。
2. **它本身就是坏的。** 它靠 master 的 EOF 判断子进程退出，而 node-pty 会漏一个 slave fd
   出去（第五节）；那个 fd 开着的话 **EOF 永远不会来**，会话退出了也报不出来。当时的
   测试测不到这一点——`native.open()` 开的是干净的一对，没有多余的 slave 引用。

所以要重做的话，别从 `bbfd3dc` 直接捡回来：形状可以抄（三个原生调用都验过好使），
但「怎么知道子进程没了」必须换一条路——而 Node 没有 `waitpid`，`process.kill(pid,0)`
对僵尸答 alive，这条是真的没有现成答案。
