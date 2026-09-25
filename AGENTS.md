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

反过来的错也被挡住了：**改完代码没重新构建就 `npm run publish`，它会拒绝**——判据是 dist
的 `index.html` 比所有源文件都新。在此之前它会照样打印成功，发上去的却是旧代码。真要发布
别处构建好的产物时用 `--allow-stale`，它会把理由打出来。

两步的语义是相反的，所以是两个函数：资产按内容哈希、只增不删、撞名报冲突（而不是静默
覆盖掉旧页面还在加载的懒加载块）并用硬链接去重；外壳没有哈希、每次构建都可能变、必须替换。

**「只增不删」的代价要定期还：`npm run prune`。** 资产从不回收，所以发布目录只会长——
一度到 930M / 4642 个文件，而当时那一版只占 125 个 / 24M，97% 是历史副本。prune 从已发布的
外壳出发算可达闭包（按资产名的哈希形状在文件里找引用，HTML、chunk 之间、CSS 的 url() 一网
打尽），可达的一律留，再加一条「最近 N 天发布的都不动」当宽限窗口。**默认是预演，不删任何
东西**，看清楚了再加 `--apply`；`--list` 打印待删清单，`--keep-days` 调窗口。

那条宽限窗口保的是「最近 N 天新出现的文件」，**不等于**「最近 N 天那几版用到的文件」——
同内容的块会被复用而不重写，mtime 停在它第一次发布的那天。抱着更旧外壳的页面去点一个自己
还没加载过的路由，仍可能 404，硬刷即可。要精确就得让 publish 记下每一版的可达集合。

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

还要注意 `deploy/tests/` **不在 workspaces 里**，上面那条命令根本不跑它；发布和 launchd
配置的测试都在那儿，要单独 `node --test deploy/tests/*.test.mjs`（`npm run verify` 里包含了）。

同理，`a && b` 串起来时前一步失败会让后一步**根本不执行**，而末尾的 `echo` 照样打印。
别把「没跑」当成「通过」。

---

## 二、你可以直接给别的终端里的 agent 发消息

这台机器上同时开着好几个终端，每个里面跑着一个 CLI。**它们之间可以直接通信**，不用人
当传声筒——这条链一直在，但以前没有任何东西告诉你它存在，所以从来没被用过。

本应用创建的每个终端都带着 `ROOST_AGENT_MESSAGE_CLI`（指向 `scripts/agent-message.mjs`）
和四个凭证变量。凭证由守护进程核验，不能通过 HTTP 自报身份，命令行也不打印它们。独立于
本应用启动的普通终端没有这些变量，调用会明确报错——那不是 bug，是边界。

```sh
# 1. 先问自己是谁。后面每一条都要带上这两个 ID。
node "$ROOST_AGENT_MESSAGE_CLI" context
# → {"conversationId":"c32959c1-…","runId":"a81450e7-…"}

# 2. 看现在能跟谁说话。
node "$ROOST_AGENT_MESSAGE_CLI" peers --from CID --run RUNID
# → {"peers":[{"recipientId":"70e35f73-…","title":"Terminal","cwd":"~/Code/retain-pdf",
#              "cli":"claude","deliverable":true,"reason":null}, …]}

# 3. 发。requestId 是你自己取的业务键，同一封信重试要用同一个。
node "$ROOST_AGENT_MESSAGE_CLI" send --from CID --run RUNID \
  --to RECIPIENT_ID --request-id some-stable-key --text "..."

# 4. 收。对方发来的信在这里。
node "$ROOST_AGENT_MESSAGE_CLI" inbox  --from CID --run RUNID
node "$ROOST_AGENT_MESSAGE_CLI" outbox --from CID --run RUNID   # 自己发出去的 + 投递状态
```

**`--from` / `--run` 是身份钉子，不是样板参数。** 它们的作用是：终端被复用、CLI 重启、
对话换了一个之后，你手上那对 ID 就不再成立，请求会以 `sender_changed` 失败。**这时候不要
自动重新 `context` 一遍再发**——那等于把上一个任务的话说给了另一个对话听。要重新确认这封信
现在还该不该发。

**`peers` 里没有的对话，此刻根本收不到信。** 那个列表用的是投递泵判断收件人的同一套条件，
所以 `deliverable: false` 的那几条会把原因写在 `reason` 里（`unsupported_cli`、
`command_pending`、`busy` 等），和界面上显示的是同一句话。别绕过它去猜 recipientId，也别用
`title` 或 `cwd` 当地址——那两个是给人看的，会变。

**`queued` 只表示「存下来了」，不表示对方收到了、更不表示对方会照做。** 命令被中断、超时、
连接断开都只能停止等待，不保证那封信没被保存；想知道结果去查 `outbox` 的投递状态，不要
换个 requestId 重发。正文上限 15 KiB。

细节和边界见 `packages/agent-messaging/README.md`。**这个包不会自我介绍**——凭证在环境里不
等于模型知道该调它，所以这一节就是那个介绍。

---

## 三、跑测试的环境要求

```sh
npm run verify   # check:syntax → typecheck → test --workspaces → deploy/tests → build frontend → check-boundaries
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

## 四、`scripts/` vs `deploy/` vs `desktop/`

**不要按名字猜**。`deploy/` 里有本机服务正在跑的东西：

| 文件 | 谁在用 |
| --- | --- |
| `deploy/terminal-owner.mts` | **`com.roost.terminal` 的入口**，PTY 就在它里面 |
| `deploy/wait-terminal-owner.mts` | 后端启动脚本先跑它，等 owner 就绪 |
| `deploy/publish.mjs` | **`npm run publish` 的入口**：查 dist 新鲜度，然后资产先、外壳后 |
| `deploy/publish-assets.mjs` | 上面那个调用的两个函数（`publishAssets` / `publishShell`），附带 br 预压缩；也能单独跑 |
| `deploy/prune-assets.mjs` | **`npm run prune` 的入口**：publish 的逆运算，按可达性回收历史资产；默认预演 |
| `deploy/static-server.mjs` `Dockerfile` `nas-*.sh` | 群晖 NAS 那套容器方案 |
| `scripts/install-service.mjs` | 生成并装载三个 launchd plist（`npm run service:install`） |
| `scripts/check-boundaries.mjs` | 依赖边界检查，见下一节 |
| `scripts/observe.mjs` | **一条命令同时看见终端画面和对话内容**，见下面 |
| `desktop/` | Tauri 桌面预览版，**不在 npm workspaces 里**，独立构建 |
| `frontend/src/embeds/` | 跑在 iframe 里、有自己 html 入口的子应用（分子编辑器）。新增一个要同时改 vite.config 和 stable-workbench/build.mjs 的 input，见该目录的 README |

### 调这条链时先开 `observe`

GUI 往终端里写字这条路要经过好几道闸（画面认得出吗、键盘归谁、有没有悬着的消息），
每一道失败都**不报错，只是不写**。挨个手工去看代价很高——2026-09-23 那次排查里
同样的一次性采样脚本被现写了四遍。

```
node --import tsx scripts/observe.mjs                 列出可观测的终端
node --import tsx scripts/observe.mjs s_xxx           打一份快照
node --import tsx scripts/observe.mjs s_xxx --watch   只在变化时打印
```

一份快照里同时有：终端画面的判定和输入框内容、写入闸此刻的理由、对话最近几条消息的角色、
待发队列每条卡在哪。**判定取自守护进程本身**（`commandControl`），不是这里重算的。

抓金样本：

```
node --import tsx scripts/observe.mjs s_xxx --capture claude-2-1-278-empty
```

只截输入框那一块（边框、`❯`、页脚），存进 `packages/terminal-daemon/tests/screens/`，
由 `real-screens.test.ts` 回放。**CLI 升级换了界面时靠这个发现**——上一次页脚措辞漂移
让整条链静默停摆，而当时没有任何用例会失败。升级后重抓一帧，判定变了测试就会红。

### 组件测试在 `frontend/tests/ui/`

`tests/` 里那些是纯逻辑测试；`tests/ui/` 里的**真的把组件渲染一遍**，接的是别处接不住的
一类毛病：**数据全都在，面板却不显示**。2026-09-23 撞过一次——用户自己的消息在库里、
在接口里、在实时流里全都有，人在界面上就是看不到，而当时仓库里一个组件测试都没有。

不引浏览器、不引新依赖：`react-dom/server` 的 `renderToString` 只跑渲染不跑副作用，
所以这一层测的是**结构**（什么内容出现在 HTML 里、标成谁说的），样式和交互不归它管。

两个前提写在文件里了：`.css` 的 import 由 `tests/ui/css-stub.mjs` 打桩（node 加载不了
样式文件）；条目要套 `ThemeProvider` 才能渲染（代码高亮要读主题）。

**从真管道走**：HistoryMessage → groupMessages → buildItems → 组件。手捏 Item 会绕过
分组那一段，而分组正是最容易把消息吃掉的地方。

---

## 五、依赖边界是被强制的

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

### 还有一条：导出了但没人用

同一个脚本里还守着「**做完了忘了接线**」。这个毛病在这个仓库里反复出现，而且每次都是
靠用户抱怨才发现的——类型检查抓不到（语法完全正确）、测试抓不到（没人测没接线的东西）、
构建也不响，它只是**静静地不存在**：

- `ConversationCatalog`：完整的历史对话浮层，零个 import。用户点遍界面找不到历史记录。
- `closeSession`：软关闭从 API 到 store 到 reducer 全套齐备，界面零入口。
- `fetchAiControl`：加进来三天，零调用方。

判据刻意取最松的一档——**任何地方提到这个名字都算用到**，包括属性访问（懒加载组件的
`m.Foo`、命名空间的 `client.foo()`）。这条检查唯一的敌人是假阳性：冤枉一次，人就会去加
豁免，豁免一多它就废了。所以它只抓「一次都没被提到过」的那种。

只扫前端的**值导出**，不扫类型、不扫各 package 内部件：那些地方「导出了但只在本文件用」
太常见，一口气报二十几条只会逼人加名单。

---

## 六、写代码的约定

- **注释解释「为什么」，不解释「是什么」。** 这个仓库里几乎每处非显然的决定上面都压着
  一段说明，很多还带着实测数字。加代码时请延续，删代码时请先读懂那段说明再决定。
- 没有 prettier、没有 eslint。行宽实际到 ~124。**不要跑 `npx prettier --write`**，
  那只会制造和其余文件不一致的噪音。
- 注释和提交信息用中文，代码标识符用英文。
- i18n 中英双语在 `packages/i18n/src/`（中文）和 `src/en/`（英文），两份形状由
  TypeScript 的 `Widen` 类型互相约束——少一个键或形状不一致，`tsc` 直接报错。
- **「纯搬运」的改动跑一次 `npm run build-diff`。** 拆文件、改目录、重命名这一类，人的
  默认假设是「产物不该变」，于是最容易跳过验证——而它们恰恰会静默坏掉。实测：把
  `index.css` 拆成九个文件时，`@font-face` 的 `url()` 是相对原文件解析的，搬走之后 Vite
  解析不到、把字面路径原样写进产物，**线上四个字体全部 404 且不报错**，只是字重悄悄退回
  系统字体。那次是靠比对产物发现的（差 8 字节）。这条脚本把那次比对固定了下来，它**不在**
  `verify` 里——多数改动本来就会改产物，挂进必跑路径只会被无视。

---

## 七、文档放哪

| 目录 | 放什么 |
| --- | --- |
| `issues/` | 已查证的缺陷。开头带 **状态**（已修／未修）和 **影响**，正文区分 **[实测]** 和推断 |
| `tasks/` | 方案与实施记录，是**当时的事实**，不要事后改写 |
| `research/` | 调研笔记。`research/third-party/` 是第三方源码浅克隆，已在 `.gitignore` 里 |
| `docs/` | 截图等资源 |

改了行为记得回头更新对应的 issue 状态——`issues/2026-09-10-*` 就是这么维护的。

---

## 八、其他容易踩的

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
