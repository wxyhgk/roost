# Roost desktop

共用的 Tauri 2 桌面工程。目前可运行的是 Apple Silicon / macOS 15+ 预览版，
Windows 和 Linux 已登记构建目标与平台配置，尚未开放构建。复用现有 React 前端、
Node 后端和独立终端守护进程；安装后的应用不需要源码目录、npm、Vite、Caddy
或机器上的 Node。当前产物采用本机 ad-hoc 签名，尚未进行 Developer ID 签名、公证。

## Structure and platform status

```text
desktop/
  bootstrap/                  启动画面；logo 由原 SVG 生成
  runtime/server.mjs          桌面后端入口、静态资源、本机会话
  scripts/
    prepare.mjs               准备运行包
    run.mjs                   统一 build / dev 入口
    targets.mjs               显示目标状态
    lib/                      目标、Node、编译、依赖、图标处理
  runtime-lock.json           按目标固定 Node 下载文件和 SHA-256
  src-tauri/
    src/
      main.rs                 窗口和应用生命周期
      backend.rs              后端进程、启动握手、免密码会话
      runtime.rs              运行包安装和清单校验
      platform/               Host 接口与已实现的 macOS 适配
    tauri.conf.json            公共配置和根项目版本
    tauri.macos.conf.json      Mac 图标、签名、app 产物
    tauri.windows.conf.json    Windows ICO、NSIS 产物规划
    tauri.linux.conf.json      Linux deb / AppImage 产物规划
  tests/                      构建目标检查、实际运行包集成测试
```

| Target | Status | 仍需完成 |
| --- | --- | --- |
| `aarch64-apple-darwin` | preview | 输入法、监听等既有待验收项见下文 |
| `x86_64-pc-windows-msvc` | planned | Host 适配、ZIP 解包、命名管道权限、Shell/CLI 启动、ConPTY 和退出恢复 |
| `x86_64-unknown-linux-gnu` | planned | Host 适配、默认 Shell、WebKitGTK 免密码启动、发行版依赖和打包验收 |

目标和支持状态集中在 `scripts/lib/targets.mjs`。`planned` 目标会在下载或修改构建
产物前返回明确错误；登记 Node 校验值、安装包格式不代表相应平台已经可运行。
Rust 的 Host 选择也会拒绝尚未启用的平台，不提供空的“成功”实现。

业务逻辑继续属于现有 `backend` / `packages`，前端继续属于 `frontend`。
Windows 的 IPC、进程识别、Shell 和 CLI 启动应在 `terminal-daemon` / `terminal-runtime`
中适配，供网页端和桌面端一起使用。桌面 `platform` 只负责原生宿主行为。

## Build and run

在仓库根目录执行（需要 Node、Rust、Xcode Command Line Tools）：

```sh
npm ci
npm run desktop:targets
npm run desktop:build
```

Mac 产物：`desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Roost.app`。
可复制到 `~/Applications` 后从 Finder 打开。`desktop:dev` 同样使用编译后的后端，
不依赖正在运行的网页开发服务器；修改后端后重新运行该命令重新生成运行包。

可显式指定目标：`npm run desktop:build -- --target aarch64-apple-darwin`。
构建必须在匹配的系统和 CPU 架构上进行，安装相应平台的原生依赖后再打包。
当前不会从 Mac 的 `node_modules` 交叉打包 Windows 或 Linux 产物。
已有前端产物时可以传 `--skip-frontend`，正式验收使用完整构建。

`tauri.conf.json` 从根 `package.json` 读取应用版本。Node 运行时版本与官方压缩包
SHA-256 按目标固定在 `runtime-lock.json`，由构建脚本下载、验证；校验值来自对应
Node 版本的官方 `SHASUMS256.txt`。Node 下载和解包缓存按版本及目标隔离。
npm 和 Cargo 依赖分别
由根 `package-lock.json`、`src-tauri/Cargo.lock` 固定。

应用图标以 `frontend/public/logos/roost-mark.svg` 为唯一图形来源，保留其几何形状，
增加白色圆角背景并生成 PNG / ICNS / ICO。修改原 SVG 后重新构建即可。

## Data and lifetime

此阶段默认使用 **`~/.roost-desktop-preview`**，不会迁移或打开现有 `~/.roost` 数据。
开发和测试可通过 `ROOST_DESKTOP_DATA_DIR` 指定其他绝对路径；不要指向正在使用的
业务数据库来进行打包测试。日志位于该目录的 `desktop.log`、`terminal-daemon.log`。

运行文件安装到 `~/Library/Application Support/Roost/runtime/<build-id>/`。
运行时不从 `.app` 或源码目录执行辅助脚本，旧发布目录不会被自动删除。
初次安装校验资源哈希和已签名 Node，后续检查安装清单及 Node 的安装时哈希。
清单包含目标、Node 文件名、可执行资源列表；启动时核对 Cargo 目标，拒绝混用其他
平台的运行包。清单和编译后的 ESM 路径统一使用 `/`，独立于宿主路径分隔符。

- 关闭窗口隐藏应用；从 Dock 重开继续使用同一窗口。
- ⌘Q 关闭应用自己启动的 HTTP 后端，不结束终端守护进程。
- 再次打开应用，HTTP 后端连接相同数据目录的守护进程。
- 机器重启、守护进程退出后的旧进程不能复活，只有历史记录可以读取。
- 桌面端直接打开工作区，不生成或读取密码文件，不显示登录或修改密码界面。
  原生层通过私有管道接收仅存在于当前 HTTP 进程内的随机会话，写入 WebView 的
  HttpOnly Cookie。会话不进入页面脚本、URL 或应用日志；HTTP 重启后旧会话失效。
  网页版原有密码登录保持不变。

HTTP 和静态文件共用一个动态分配的 `127.0.0.1` 端口，保留现有 HTTP / WebSocket
协议、Origin / Host 检查和认证。页面没有 Tauri shell / filesystem 等原生权限。
外部 HTTP(S) 导航在系统浏览器中打开。

## Verification

```sh
npm run desktop:prepare
npm run desktop:test
npm run verify
cd desktop/src-tauri
cargo test --release --target aarch64-apple-darwin
```

签名会改变 Node 的权限与字节；还需用最终 `.app` 里的运行文件执行同一集成测试：

```sh
ROOST_DESKTOP_BUNDLE="$PWD/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Roost.app" npm run desktop:test
```

桌面集成测试把完整运行包复制到带中文和空格的临时路径，使用随包 Node 和最小
PATH 启动，验证原生 PTY / sharp、静态文件、无密码本机会话和访问限制、监控采集子进程、
文件监听子进程、中文终端输出，以及 HTTP 重启后的 PID / 实例 / 回放保持一致。
测试仅清理自己创建的进程和临时数据。

构建目标检查可独立运行：`node --test desktop/tests/targets.test.mjs`。它验证目标
匹配、运行时锁、依赖平台过滤，以及未就绪目标不会修改当前运行包。
`runtime.test.mjs` 当前执行的是 Mac 原生产物验收；其他平台启用前，需要扩充
安装包定位、测试环境和退出清理规则，并在各平台 CI 与真实 UI 上验证。

已在实际 `.app` 中检查免密码进入、隐藏密码设置、新建终端、中文输出和 OpenCode
1.18.30 启动界面。退出应用、替换构建并重开后，原 PTY 的 PID / 实例保持一致，
重新选择终端可恢复 OpenCode 画面。免密码版本此前的全仓库回归为 993 通过、10
跳过，类型、前端构建及包边界检查通过。目录重构的验收结果单独记录，不能将这些
Mac 检查当作 Windows / Linux 的验证结果。

本次目录重构验收：前端构建、包边界和桌面 JS 语法检查通过；签名 Mac 产物的
桌面测试 5 项通过，Rust 测试 2 项通过。已替换并重开本机预览版，直接进入工作区；
替换前已有的守护进程和终端 PID / 实例保持一致，终端画面恢复。

中文输出通过不代表中文输入法通过：自动化直接注入中文时字符
未进入终端，尚未确认是自动化输入方式还是 WebKit 兼容问题。真实输入法组合、
候选框、原位置预显、多终端缩放、CLI 对话交互及休眠唤醒仍待验收。

本机主目录和 `/private/tmp` 的文件侧栏出现过“自动同步已停止”；隔离目录中的
文件监听子进程集成测试通过，实际大目录监听问题仍需单独定位。

## Next stages

现有数据接入、GUI 偏好跨端口保存、后端崩溃后的界面恢复、下载和原生通知、完整
退出入口、系统签名公证和自动更新不属于第一阶段。尤其不能把当前“保留运行目录”
理解为已经实现跨版本协议 / 数据库兼容升级或安全回滚。

平台配置与 sidecar 命名遵循 Tauri 官方说明：
[平台配置合并](https://v2.tauri.app/reference/config/#platform-specific-configuration)、
[外部运行程序](https://v2.tauri.app/develop/sidecar/)。
