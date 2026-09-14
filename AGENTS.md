# AGENTS.md

给在这个仓库里工作的 AI 助手看的。写的是**光读代码看不出来、但踩了会疼**的事，
不重复 README 已经讲清楚的部分。

Roost 是本机单用户的终端工作台：浏览器里管理 shell 会话，AI 能力来自终端里跑的 CLI。

---

## 一、先读这一节：三条最容易犯的错

### 1. 重启 terminal 服务会杀掉所有会话，包括你自己

PTY 全部活在 `com.roost.terminal` 这一个进程里。

| 服务 | 重启安全吗 |
| --- | --- |
| `com.roost.backend` | **安全**，PTY 不受影响（`backend/tests/daemon-restart.test.ts` 钉着这件事） |
| `com.roost.web` | 安全，只是 Caddy |
| `com.roost.terminal` | **会结束全部终端**，包括你正在说话的那个 |

要动 terminal 服务时：先告诉用户会断，并且脚本要用 `nohup` 脱离当前 PTY——否则脚本
自己会在第一步被杀掉，留下半完成状态。**macOS 没有 `setsid`**，别用。

一律用 `launchctl kickstart -k gui/$(id -u)/com.roost.<svc>`。不要 kill 后手动拉起，
那会和 `KeepAlive` 抢，日志里出 `EADDRINUSE`。

### 2. 发布前端是 `npm run publish`，不是 `npm run build`

```sh
npm run build --workspace frontend   # 只写 frontend/dist，碰不到线上
npm run publish                      # 让它生效：资产先、外壳后
```

Caddy 服务的两个 root **都在 `~/.local/share/roost/` 下**：`/assets/*` 取自 `assets/`，
其余取自 `web/`。两处都由 `deploy/publish.mjs` 写入，构建产物目录不再被直接服务
（`deploy/tests/install-service.test.mjs` 钉着这一条）。

**顺序是这件事的要害，而且和直觉相反：资产先、外壳后。** 三种组合里：

| | |
| --- | --- |
| 旧外壳 + 新资产 | 好的——资产只增不删，旧外壳引的哈希还在 |
| 新外壳 + 新资产 | 好的 |
| 新外壳 + 旧资产 | **入口脚本 404、页面纯白**，被顺序排除了 |

在此之前兜底 root 直接就是 `frontend/dist`，于是 `npm run build` 自己就会造出第三种状态：
它先把 `index.html` 换成指向新哈希的版本，而那些哈希要等发布才到位。**两天内栽了三次**，
每次的补救都停在「记得跑第二步」那一档——而那一档永远靠人。现在构建碰不到线上，
「构建了没发布」等于什么都没发生。

两步的语义是相反的，所以是两个函数：资产按内容哈希、只增不删、撞名报冲突（而不是静默
覆盖掉旧页面还在加载的懒加载块）并用硬链接去重；外壳没有哈希、每次构建都可能变、必须替换。

**`npm run workbench:build` / `workbench:install` 不是发布前端。** 它构建的是
`stable-workbench`——用同一份前端源码打出的独立降级版本，有自己的服务器，默认只装成候选。
跑它不会更新线上那份。

### 3. 看输出的尾巴不等于看结果

`npm test --workspaces` 的输出很长。用 `tail` 看结尾会漏掉中间失败的包——这个仓库里
已经因此漏过一次回归。正确做法是过滤出 `fail≠0` 的包：

```sh
npm test --workspaces --if-present 2>&1 \
  | grep -E "^> @roost|^> backend|^> frontend|^ℹ (tests|pass|fail)" | paste - - - - | grep -v "fail 0"
```

同理，`a && b` 串起来时前一步失败会让后一步**根本不执行**，而末尾的 `echo` 照样打印。
别把「没跑」当成「通过」。

---

## 二、跑测试的环境要求

```sh
npm run verify   # typecheck --workspaces && test --workspaces && build frontend && check-boundaries
```

Node **≥ 22.13.0**（`engines` 里声明了，`node:sqlite` 划的下限）。22 / 24 / 26 都实测全绿。

两个环境陷阱，不满足会看到与改动无关的红：

- `umask 022` —— `backend/tests/auth-config.test.ts` 校验文件权限位，在 `umask 077` 下会失败
- `env -u ROOST_CLAUDE_OBSERVING` —— 在 Roost 自己的终端里跑时这个变量会被继承，
  `claude-launch.test.ts` 因此失败

所以完整命令通常是：

```sh
umask 022 && env -u ROOST_CLAUDE_OBSERVING npm test --workspaces --if-present
```

---

## 三、`scripts/` vs `deploy/` vs `desktop/`

**不要按名字猜**。`deploy/` 里有本机服务正在跑的东西：

| 文件 | 谁在用 |
| --- | --- |
| `deploy/terminal-owner.mts` | **`com.roost.terminal` 的入口**，PTY 就在它里面 |
| `deploy/wait-terminal-owner.mts` | 后端启动脚本先跑它，等 owner 就绪 |
| `deploy/publish-assets.mjs` | 发布哈希资产的正规工具 |
| `deploy/static-server.mjs` `Dockerfile` `nas-*.sh` | 群晖 NAS 那套容器方案 |
| `scripts/install-service.mjs` | 生成并装载三个 launchd plist（`npm run service:install`） |
| `scripts/check-boundaries.mjs` | 依赖边界检查，见下一节 |
| `desktop/` | Tauri 桌面预览版，**不在 npm workspaces 里**，独立构建 |
| `frontend/src/embeds/` | 跑在 iframe 里、有自己 html 入口的子应用（分子编辑器）。新增一个要同时改 vite.config 和 stable-workbench/build.mjs 的 input，见该目录的 README |

---

## 四、依赖边界是被强制的

`scripts/check-boundaries.mjs` 会让验证失败。它管的事：

- `packages/*` 之间只能走公开入口，不许跨目录读别人的内部文件
- 前端、`terminal-protocol`、`cli-adapters`、`stable-workbench` 里**不许出现 Node 依赖**
- `shared/` 不许依赖 `features/`；`shared/store/state|observable` 不许依赖 React
- 只有**注册表**能认识具体插件（两张：`plugins/index` 是渲染在预览弹窗里的，
  `plugins/external` 是活在弹窗之外、由 Shell 挂载的）；插件之间不许互相 import。
  分成两张不是为了好看——`Shell` 是首屏，合成一张会把 markdown/code/media 那串
  本该懒加载的东西拖进首屏，实测 gzip 386.3 → 560.8 KB
- `features/terminal/public.ts` 是轻量入口，不许加载终端引擎

它提取 import 用的是**启发式正则**，所以注释里写 `from "……"` 这种散文会被误判成
import。撞上了就改措辞，不要为此放宽检查。

---

## 五、写代码的约定

- **注释解释「为什么」，不解释「是什么」。** 这个仓库里几乎每处非显然的决定上面都压着
  一段说明，很多还带着实测数字。加代码时请延续，删代码时请先读懂那段说明再决定。
- 没有 prettier、没有 eslint。行宽实际到 ~124。**不要跑 `npx prettier --write`**，
  那只会制造和其余文件不一致的噪音。
- 注释和提交信息用中文，代码标识符用英文。
- i18n 中英双语在 `packages/i18n/src/`（中文）和 `src/en/`（英文），两份形状由
  TypeScript 的 `Widen` 类型互相约束——少一个键或形状不一致，`tsc` 直接报错。

---

## 六、文档放哪

| 目录 | 放什么 |
| --- | --- |
| `issues/` | 已查证的缺陷。开头带 **状态**（已修／未修）和 **影响**，正文区分 **[实测]** 和推断 |
| `tasks/` | 方案与实施记录，是**当时的事实**，不要事后改写 |
| `research/` | 调研笔记。`research/third-party/` 是第三方源码浅克隆，已在 `.gitignore` 里 |
| `docs/` | 截图等资源 |

改了行为记得回头更新对应的 issue 状态——`issues/2026-09-10-*` 就是这么维护的。

---

## 七、其他容易踩的

- **Claude 额度不显示**：`~/.claude/settings.json` 的 `statusLine.command` 和
  `~/.roost/subscriptions/claude-statusline-config.json` 的 `installedCommand` 必须**逐字相等**，
  `claudeConnected()` 就是比这两个串。不相等时**先修 `installedCommand`，不要先点重连**
  ——重连会把当前命令误存成「用户原有的 statusLine」，以后就断不干净了。
- **`node:sqlite` 的触发器**用 `CREATE TRIGGER IF NOT EXISTS`，已有数据库里的不会重建。
  所以 `diy_conversation_writer_v1` 这个函数名**不能改**（项目已改名为 Roost，这一处
  是有意保留的），改了会让那几张表的每一次写入都 ABORT。
- CLI 启动脚本是**模板字符串**（`*-launch.ts` 里的 `String.raw`），写进临时目录当垫片跑。
  它们没有模块边界，共享代码靠 `cli-launch-tools.ts` 内联。测试的办法是把导出的文本
  实例化成函数并注入桩，见 `tests/cli-launch-tools.test.ts`。
