# 在 Linux 上用 systemd 跑 Roost

**仓库不提供 systemd unit。** `scripts/install-service.mjs` 生成的是 macOS 的 launchd
plist；Linux 这边要自己写。这份文档不给模板，只写**自己写 unit 时会踩的东西**——那些
"配好了、服务也起来了、但某个功能莫名其妙不工作"的组合。

结构和 macOS 那三个服务一一对应（见根 README 的「装成系统服务」）：

| 服务 | 跑什么 |
| --- | --- |
| terminal | `deploy/terminal-owner.mts`，**PTY 都在这个进程里** |
| backend | 先跑 `deploy/wait-terminal-owner.mts` 等 owner 就绪，再起 `backend/src/index.ts` |
| web | 静态资源 + 反代 `/api`（Caddy，或 `deploy/static-server.mjs`） |

`backend` 和 `web` 随便重启；**重启 terminal 会结束所有会话。**

---

## 加固指令：五条会咬人的

systemd 的加固选项（`systemd-analyze security` 会催你全开）大多数对 Roost 是有害的，
而且失败形态都不直白。逐条说清楚它咬在哪。

下面「机制」一栏是这些指令**自身的语义**加上仓库代码里能查到的事实（路径、socket
位置）；**没有在 Linux 上实跑验证过**，所以不标 [实测]。

### `NoNewPrivileges=yes` —— Roost 终端里 `sudo` 会失效

**症状**：同一台机器，ssh 进去 `sudo` 好好的，从 Roost 的终端里跑就失败。

**机制**：`NO_NEW_PRIVS` 一旦置位就**跨 fork/exec 继承，而且不可撤销**。守护进程带上
它，它下面每一个 PTY、每一个 shell 都带着；而 `sudo` 靠 setuid 提权，当场失效。

**但先别急着关掉。** 这里有个真实的取舍：

Roost 的认证只有一道本地密码，而登进来的人能往终端里发任意输入（根 README 的
「安全边界」那节写明了）。**PTY 里允许 `sudo`，等于越过那道密码的人可以直接拿到
root**，而不只是拿到运行 Roost 的那个用户。

所以「Roost 终端里不能 sudo，要管服务就去外部终端」**更像是一个合理的姿态，不是一个
待修的缺陷**。真想放开，该问的不是「怎么关掉这个开关」，而是「这台机器上，那道密码
值不值得托付 root」。想清楚了再把 terminal 那个 unit 改成 `NoNewPrivileges=no`。

### `PrivateTmp=yes` —— backend 会永远找不到守护进程

**症状**：两个服务各自都"启动成功"，但网页一直连不上终端，backend 表现得像守护进程
根本没跑。

**机制**：POSIX 下守护进程的 IPC socket 在 `/tmp` 里
（`packages/terminal-daemon/src/socket.ts`：`/tmp/diy-pty-<uid>-<dataDir 哈希>.sock`）。
`PrivateTmp=yes` 给每个 unit **各自一个私有的 `/tmp` 命名空间**——terminal 在它自己的
`/tmp` 里 bind，backend 在它自己的 `/tmp` 里找，两个 `/tmp` 不是同一个。

要么两个 unit 都别开，要么给它们配同一个挂载命名空间。**只给其中一个开是最坏的情况**：
错误信息只会说连不上。

### `ProtectHome=yes` / `read-only` —— 数据目录和用户的文件都没了

数据默认在 `~/.roost/`（`ROOST_DATA_DIR` 可改），发布出去的前端资产在
`~/.local/share/roost/`。更要紧的是：**用户开终端就是为了操作自己 home 底下的文件**，
把 home 挡住等于把这个应用的用途挡住。

要收紧就用 `ReadWritePaths=` 精确放行，别用 `ProtectHome`。

### `ProtectSystem=strict` —— 发布前端会写不进去

`npm run publish` 写 `~/.local/share/roost/{assets,web}`。`strict` 下整个文件系统只读，
要把这两个路径显式放进 `ReadWritePaths=`。

### `MemoryDenyWriteExecute=yes` —— Node 起不来

V8 的 JIT 要可写可执行的内存页。这条开了任何 Node 服务都跑不了，和 Roost 无关，但它
在"一键加固"的清单里，顺手记一笔。

---

## 一句总结

Roost 是**替你在本机跑任意命令**的工具，它的用途和"最小权限"天然是拧着的。加固该用
`ReadWritePaths=` 这类**精确放行**去做，而不是整类关掉——后者的失败大多是静默的，
排查成本远高于它挡住的风险。
