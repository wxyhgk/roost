<img src="frontend/public/favicon.svg" width="64" alt="">

# Roost

**在浏览器里管理 shell 会话的本机工作台。关掉标签页，里面跑着的东西也不会停。**

![Roost 的三栏界面：左侧会话列表、中间终端、右侧文件树](docs/roost.png)

跑一个 AI CLI，它可能要工作二十分钟——而你恰恰需要在这二十分钟里去干点别的。

`tmux` 能让会话活下来，但它不知道终端里跑的是什么；网页终端方便，但会话跟着页面一起死。
Roost 两样都要：

- **会话活在页面之外。** PTY 由独立进程持有。后端崩了、你改了一行代码重启它、断网十分钟
  ——终端不受影响，回来从你**已经看完的位置**继续收，不重放、不丢中间段。
- **它认得出里面在跑什么。** 侧边栏实时显示"在干活 / 干完了 / 在等你批准"，安静下来发
  通知。这些来自 CLI 自己的 hook 和协议，**不是读屏幕猜的**。

AI 能力不由 Roost 提供，来自你自己跑的 CLI。目前认识
**Claude Code / Codex / Gemini CLI / OpenCode / Qwen Code / Grok / Oh My Pi**。

## 跑起来

需要 **Node.js ≥ 22.13.0**（下限由 `node:sqlite` 划的）。

```sh
npm ci        # 首次，项目根目录
npm start     # 打开 http://localhost:5173
cat ~/.roost/auth-password   # 首次启动生成的随机密码
```

## 还有什么

**终端**：一个会话多个窗口各自恢复，搜索，图片直接粘进 CLI，本地回显预测（跨太平洋
打字也跟手），改尺寸时旧输出不会被重新折行。

**文件**：树形 / 列表浏览，服务端快速搜索，上传下载，拖到终端变路径。
预览支持代码、图片、PDF、Markdown、3D 分子；编辑原子写回并检测外部改动。

**其他**：随会话走的笔记和片段库，`.mol` / `.sdf` 画完直接送进终端，
服务与资源监控，中英双语。

## 安全边界

不是托管服务，没有多租户和权限模型。认证只有一道：本地生成的随机密码，写在
`~/.roost/auth-password`（0600）。

**它挡的是同一网络里的其他人，不是为公网暴露设计的。** 登进来的人能在你机器上执行
任意命令。要放公网，请在反向代理那层再加一道。

纯 HTTP 访问要显式放行 `ROOST_AUTH_INSECURE_HTTP=1`；跨来源用 `ROOST_ALLOWED_ORIGINS`。

## 装成系统服务

`npm start` 是开发入口——关掉它终端就停了。要让它一直在：

```sh
npm ci && npm run build --workspace frontend
brew install caddy
npm run service:install     # 入口 http://localhost:8080
```

`npm run service:status` 看状态，`service:uninstall` 卸载（不动数据），
`node scripts/install-service.mjs --dry-run` 只打印不动系统。

**装三个服务而不是一个**，因为 PTY 必须活在一个不会因为改代码而重启的进程里：

| 服务 | 跑什么 |
| --- | --- |
| `com.roost.terminal` | PTY 都在这个进程里 |
| `com.roost.backend` | 等 owner 就绪后起 HTTP 后端 |
| `com.roost.web` | 静态资源 + 反代 `/api` |

`backend` 和 `web` 随便重启，终端不受影响；**重启 `terminal` 会结束所有会话**。
日志在 `~/.roost/logs/`。

Linux 用 systemd 同理。群晖 NAS 见 [`deploy/README.md`](deploy/README.md)。
改完前端发布：`npm run build --workspace frontend && npm run publish`（资产先、外壳后，
反过来会白屏）。

## 要知道的几件事

- **守护进程退出或机器重启，运行中的任务不能恢复**，其余情况（刷新、断网、后端重启、
  后端崩溃）都能。`npm run daemon:status` / `daemon:stop` 管它。
- **Hide** 只是隐藏，进程还在；**Kill** 才终止并删记录。Shell 退出后的"重新启动终端"
  是新进程，保存的画面不代表原来的程序还活着。
- 历史有容量上限，超出时优先保留近期内容并在页面上提示。另有完整归档（默认 256 MiB），
  可分页查看、搜索、下载。
- 数据默认在 `~/.roost/workspace.sqlite`，`ROOST_DATA_DIR` 可换目录。

## 开发

```sh
npm run dev      # 后端改动自动重载，PTY 保持运行（和 npm start 同端口，别同时开）
npm run verify   # 类型检查 + 测试 + 前端构建 + 依赖边界检查
```

改了守护进程或运行时的源码，**要停掉守护进程再启动才生效，这会结束已有终端**。

包在 `packages/`（协议、运行时、守护进程、存储、附件、CLI 适配），应用在 `backend/`
和 `frontend/`。包之间只走公开入口，`verify` 会检查。
详见 [终端守护进程说明](packages/terminal-daemon/README.md)。

## 给 AI 助手

先读 **[AGENTS.md](AGENTS.md)**：光读代码看不出来、但踩了会疼的事。
[CLAUDE.md](CLAUDE.md) 指向同一份。

`issues/` 是已查证的缺陷，`research/` 是调研笔记——包括一些"查完决定不做"的结论
和它们的理由。

## 许可

[MIT](LICENSE)。
