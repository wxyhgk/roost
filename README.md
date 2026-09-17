<img src="frontend/public/favicon.svg" width="64" alt="">

# Roost

**在浏览器里管理 shell 会话的本机工作台。关掉标签页，里面跑着的东西也不会停。**

会话不住在网页里，住在一个独立的守护进程里。刷新、断网、重启 HTTP 后端、合上笔记本，
回来时终端还在原地——Roost 就是它们飞回来歇着的那根横木。

![Roost 的三栏界面：左侧会话列表、中间终端、右侧文件树](docs/roost.png)

## 为什么会有这个东西

跑一个 AI CLI，它可能要工作二十分钟。这二十分钟里你不能关标签页、不能换个地方看、
不能重启后端——**而你恰恰需要在这二十分钟里去干点别的。**

`tmux` 能让会话活下来，但它不知道终端里跑的是什么；网页版的终端方便，但会话通常
跟着页面一起死。Roost 想要的是两样都有：

- **会话活在页面之外。** PTY 由一个独立进程持有。后端崩了、你改了一行代码重启它、
  网断了十分钟——终端不受影响，回来从你**已经看完的位置**继续收输出，不重放、不丢中间段。
- **它认得出里面在跑什么。** 识别常见的 AI CLI，读它们的会话记录，在侧边栏显示
  "在干活 / 干完了 / 在等你批准"，回复时图标会转。你可以合上电脑，回来一眼看出哪个在等你。

AI 能力**不由 Roost 提供**，来自你自己在终端里跑的 CLI。Roost 做的是给它们一个能随时
回来的地方，再在旁边配上文件树、预览、笔记。
目前认识 **Claude Code / Codex / Gemini CLI / OpenCode / Qwen Code / Grok / Oh My Pi**。

## 三分钟跑起来

需要 **Node.js ≥ 22.13.0**。

```sh
npm ci        # 首次，在项目根目录（npm workspaces，共用一个锁文件）
npm start
```

打开 <http://localhost:5173>。首次启动会生成一个随机密码：

```sh
cat ~/.roost/auth-password
```

就这样。想让它开机自启、关掉终端窗口也不影响，往下看[装成系统服务](#装成系统服务)。

## 能做什么

**终端**
一个会话多个窗口，各自从自己的位置恢复；搜索、诊断面板、触摸选择、图片直接粘贴进 CLI；
本地回显预测，跨太平洋的链路上打字也跟手。

**文件**
树形 / 列表两种浏览，服务端一次遍历的快速搜索，上传下载，右键菜单，拖到终端变路径。
预览是插件式的：代码走 CodeMirror + Shiki，还有图片、PDF、Markdown、3D 分子。
编辑原子写回并检测 mtime 冲突。弹窗能拖能缩，可以钉成悬浮窗。

**会话状态**
侧边栏实时显示每个 CLI 在干什么，未读提示，"在等你批准 / 在等你回答"角标，
安静下来时发浏览器通知。这些信息来自 CLI 自己的 hook 和协议，**不是读屏幕猜的**。

**还有**
随会话走的本地笔记和代码片段库；`.mol` / `.sdf` 用 Ketcher 画完直接送进终端；
服务状态、CPU、内存监控（systemd 和 launchd 都认）；中英双语界面。

## 它不是什么

**不是**托管服务或云 IDE。没有多租户、组织、权限模型。

认证只有一道：一个本地生成的 32 字节随机密码，写在 `~/.roost/auth-password`（权限 0600）。
**它挡的是同一网络里的其他人，不是为公网暴露设计的。** 登进来的人能读写工作目录、
能往终端里发输入——也就是能在你机器上执行任意命令。要放公网，请在反向代理那一层
再加一道访问控制。

纯 HTTP 访问（本机直连或内网 IP）需要显式放行，因为默认假定你走 HTTPS：

```sh
ROOST_AUTH_INSECURE_HTTP=1 npm start
```

跨来源访问用 `ROOST_ALLOWED_ORIGINS` 声明，逗号分隔。

## 装成系统服务

`npm start` 是开发入口——关掉它，终端也就停了。要让它一直在：

```sh
npm ci
npm run build --workspace frontend
brew install caddy          # 已经有了就跳过
npm run service:install
```

装完登录即自动启动，异常退出自动拉起，关掉 SSH 或终端窗口都不影响。入口
<http://localhost:8080>。

```sh
npm run service:status      # 三个服务各自什么状态
npm run service:uninstall   # 卸载，不动数据目录
node scripts/install-service.mjs --dry-run   # 只打印将要写的东西，不动系统
```

常用开关：`--port` `--backend-port` `--origins` `--data-dir` `--caddy` `--secure-cookies`。

**为什么是三个服务而不是一个。** PTY 必须活在一个不会因为改代码而重启的进程里：
后端崩了、重启了、你改了一行代码，正在跑的 CLI 都不该跟着死。

| 服务 | 跑什么 |
| --- | --- |
| `com.roost.terminal` | `deploy/terminal-owner.mts`，**PTY 都在这个进程里** |
| `com.roost.backend` | 先等 owner 就绪，再起 `backend/src/index.ts` |
| `com.roost.web` | Caddy：提供 `frontend/dist`，把 `/api` 反代给后端 |

`backend` 和 `web` 随便重启，终端不受影响；**重启 `terminal` 会结束所有会话**。
日志在 `~/.roost/logs/`。

Linux 用 systemd 是同样三件事。群晖 NAS 的容器方案见 [`deploy/README.md`](deploy/README.md)。

改完前端要重新发布静态资源：`npm run build --workspace frontend && npm run publish`。
顺序是**资产先、外壳后**——反过来会有一段时间入口脚本 404、页面纯白。

---

<details>
<summary><b>会话、数据与恢复的细节</b></summary>

### 会话生命周期

- 刷新网页或短暂断线：守护进程中的 Shell 仍在时可重连。
- **Hide session**：隐藏会话，保留后台进程；Reopen 重新连接。
- **Kill session**：终止进程并删除会话记录。
- Shell exited 后的"重新启动终端"：沿用会话和目录启动新 Shell。
  保存的画面不代表原来的程序仍在运行。
- HTTP 后端退出、重启或崩溃：守护进程中的任务继续运行，网页恢复连接后补收输出。
- **守护进程退出或机器重启：原来的运行任务不能恢复**，需启动新 Shell。
- `npm run daemon:status` 查看守护进程；`npm run daemon:stop` 主动停止它及其所有终端。

### 恢复是怎么做到的

每个窗口从自己**已经显示完整**的位置继续接收输出。守护进程保留 PID、实例 ID 和输出
游标；真正启动新 Shell 时才产生新的实例标识，所以两个窗口可以分别恢复。

会话中途改过尺寸时，重放会**按录制时的几何分段**——旧宽度的输出不会被按新宽度重新折行。

历史保留有容量限制：每个会话最多约 2,000,000 个 UTF-16 代码单元的原始输出及 16,384 个
输出片段；落盘的历史画面与增量合计上限 512,000 个代码单元。超出时优先保留近期内容，
页面会提示历史可能不完整。快照本身不会被截成半段终端控制序列。

另有按会话追加的完整归档（默认上限 256 MiB），可通过终端栏的历史记录按钮分页查看、
搜索与下载；删除会话会连带删除其归档。

运行中按约 1.5 秒批次写入。守护进程收到 `SIGINT` / `SIGTERM` 时保存历史并结束 PTY；
强制杀掉或断电仍可能丢失尚未落盘的内容。

旧数据库会自动增加恢复元数据列。旧记录缺少精确快照边界时，优先恢复最近的原始输出，
并提示历史可能不完整。更新前已经打开的页面请刷新一次，用新的恢复协议。

### 数据在哪

默认 `~/.roost/workspace.sqlite`。设置 `ROOST_DATA_DIR` 可使用独立数据目录（适用于隔离
测试，不会迁移默认目录的数据）。后端也支持 `HOST`、`PORT`；改了后端端口要相应调整
`frontend/vite.config.ts` 里的代理目标。

</details>

<details>
<summary><b>开发与代码组织</b></summary>

### 两个入口

`npm start` 让 HTTP 后端以非 watch 模式运行，前端用 Vite 开发服务器。
`npm run dev` 则在改动后自动重载后端，重载后会重新连接同一个守护进程，PTY 保持运行。
**两个入口使用相同端口，不要同时启动。**

### 验证

```sh
npm run verify
```

依次执行所有包与应用的类型检查、测试、前端生产构建和包依赖边界检查；任一步失败即返回
非零退出码。回归测试使用临时文件或 mock 数据，不读取用户的工作区数据库，也不向运行中
的服务发送测试消息。

各 Node 版本实测（`npm test --workspaces`）：20.20.2 跑不了（`No such built-in module:
node:sqlite`）；22.13.0 / 22.23.2 / 24.21.0 / 26.8.2 全绿。下限由 `node:sqlite` 划定——
Node 20 没有这个模块，22.5 有但要 `--experimental-sqlite`，22.13 起无标志可用。

### 包怎么分的

私有本地包与前后端一起安装、一起发布，不需要发布到 npm。

| 位置 | 负责什么 |
| --- | --- |
| `packages/terminal-protocol` | 前后端共同的终端消息、版本和校验 |
| `packages/terminal-runtime` | Shell 进程、输入输出、历史恢复与资源释放 |
| `packages/terminal-daemon` | 独立终端进程、本机 socket 和客户端 |
| `packages/workspace-store` | 项目、会话及终端历史的 SQLite 存储 |
| `packages/attachment-store` | 图片接收、校验、占用统计和主动清理 |
| `packages/cli-adapters` | CLI 识别与图片插入规则 |
| `backend/src` | 启动配置、HTTP/WebSocket 接口、文件预览，以及组装这些包 |
| `frontend/src` | 界面和浏览器终端 |

包通过公开入口导入，**禁止跨目录读取另一个包内部文件**（`npm run verify` 会检查）。
协议包保持浏览器可用；存储和运行时通过工厂创建，单纯导入不会打开数据库或启动 Shell。

只验证终端能力：

```sh
npm test --workspace @roost/terminal-runtime
npm run typecheck --workspace @roost/terminal-runtime
```

改了 HTTP 后端源码，`npm start` 模式需重启后端，`npm run dev` 会自动重载。
**改了守护进程或运行时源码，要停掉守护进程再启动才生效，这会结束已有终端。**

详见 [终端守护进程说明](packages/terminal-daemon/README.md)、
[附件管理接口](backend/ATTACHMENTS_API.md)。

安装时会自动修复 macOS 预编译 PTY 辅助程序的执行权限。如果原生 PTY 模块仍无法加载，
可尝试 `npm run rebuild-pty --prefix backend`（需要本机编译工具链）。

</details>

## 给 AI 助手

在这个仓库里工作的 AI 助手请先读 **[AGENTS.md](AGENTS.md)**：里面是光读代码看不出来、
但踩了会疼的事——哪个服务重启会杀掉所有终端、发布前端为什么不能用 `cp`、跑测试要先
`umask 022`、依赖边界检查管什么。[CLAUDE.md](CLAUDE.md) 指向同一份，不另写一遍。

仓库里还有两类写给人看的笔记：`issues/` 是已查证的缺陷（区分**实测**和推断），
`research/` 是调研，包括一些"查完决定不做"的结论和它们的理由。

## 许可

[MIT](LICENSE)。
