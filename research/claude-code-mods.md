# Claude Code Mods（function hooks）：等它发了再动（记于 2026-09-17）

来源：[anthropics/claude-code#91870](https://github.com/anthropics/claude-code/issues/91870)
《Mods - make Claude 10x more extensible》。官方发的征求意见帖，2026-09-03 开的，
open，当天还在更新，189 条评论，标签 `enhancement` / `area:hooks` / `area:plugins`。

**这份只是存档。现在不要动我们的观察插件**，理由在最后一节。

---

## 提议的是什么

把 hook 从「配置里写一条 shell 命令」换成 **TypeScript 函数**。一个插件导出
`register(on, options)`，每个 hook 的形状是 `($, e, next)`——Express / Koa 的中间件，
**注册顺序即嵌套顺序**：先注册的包住后面的，所以管理员 prepend 拿控制权、append 给
默认值。

几个和我们有关的点：

- **`$` 是所有副作用的唯一出口。** 因此每一次调用都能被看见、被拦。`on('*')` 收到
  每一个事件，**包括别的插件对 `$` 的调用**——官方的说法是「审计日志就是一个函数」。
- **能 hook 界面。** CC 自己是 React 写的，插件可以改组件的 props、包住它返回的渲染
  节点。`ui.press` 这一个 hook 在终端里和桌面端里看到的是同一次按钮点击。
- **插件能往 `$` 上挂名词。** 内置的 telemetry mod 在 `engine.create` 那一折里加了
  `$.telemetry`，别的插件直接调；名词的类型由加它的那个 mod 独家声明（`types/index.d.ts`），
  调用方只许 import 不许抄一份。

## 状态

- 2026-09-09 的更新里承诺要发，「N 周」量级，产品名定为 **Claude Mods**；function hook
  是底层原语的叫法，mod 就是用了 function hook 的 plugin。
- 现在就能试：`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`（帖子里说的是 v267/v268）。
- 三个内置 mod 的源码已公开在 `anthropics/claude-code/mods`：`sec-default`（把组织的
  托管设置、工具策略挡在用户装的插件之外）、`diff`（`/diff` 的侧栏）、`telemetry`。
- 配套有测试框架：`claude plugin test mods/diff`，带 `tier()` 和 `mock.clock` /
  `mock.env` / `mock.store`；`mock.clock` 的 `advance(ms)` 会解掉 mod 等的每一个 sleep。

## 对我们意味着什么

**我们已经在给 claude 注入插件了。** `packages/terminal-daemon/src/claude-launch.ts`
生成一个临时插件目录 `roost-terminal-observer`，靠 `--plugin-dir` 挂上去，用的是老式
command hook：`SessionStart` / `UserPromptSubmit` / `Stop` 三个事件，每次事件
`spawn` 一遍 `node observe.mjs`，`timeout` 写死 2 秒。

换成 function hook 之后能拿到的：

- 不再「每个事件启动一次 node 进程」；
- 没有那个 2 秒超时的悬崖——现在慢一点的机器上它是会真的被砍掉的；
- 事件多一个量级。我们现在只有三个粗粒度的点，而 `*` 能看到全部。

## 等它发了要先验的两件事

1. **我们的注入方式还兼容吗。** 我们是「临时目录 + `--plugin-dir`」，不是装在用户的
   插件目录里。mod 的加载、tier 归属是不是认这条路，帖子里看不出来。
2. **tier 和权限分层落在哪。** `sec-default` 这个 mod 的存在说明有分层（管理员的能挡住
   用户装的）。我们是本地单人，大概率落在普通 tier，但这是第一件要确认的事——如果观察
   插件被归到某个受限层，`observe.mjs` 现在能做的事未必还能做。

在这两条问清楚之前不要改 `claude-launch.ts`：现在这套是能用的，而换过去的收益是性能和
事件粒度，不是「不换就不行」。
