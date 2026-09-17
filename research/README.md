# 第三方项目研究

`third-party/` 存放独立 Git 仓库，不纳入主项目版本控制，也不加入 npm workspaces。
研究结论可保存在本目录的 Markdown 文件中。不要将第三方服务连接到当前应用数据目录。

| 项目 | 源码目录 | 上游 | 研究重点 |
|---|---|---|---|
| Happier | `third-party/happier/` | https://github.com/happier-dev/happier | 原生 TUI 与 GUI 的会话同步、输入协调、权限确认 |
| DeepSeek Harness | `third-party/deepseek-harness/` | https://github.com/deepseek-ai/deepseek-harness | 插件化的 agent 工作台：工具调用渲染、上下文压缩、slot 架构 |

初步研究记录：[Happier TUI / GUI 同步](happier-tui-gui-sync.md)。

工具渲染器设计：[Happier GUI 工具渲染器](happier-gui-renderers.md)。

订阅面板接口：[Claude、Codex 与 OpenCode Go 额度调研](ai-subscription-apis.md)。

工具渲染与上下文管理：[DeepSeek Harness 工具调用渲染](deepseek-harness-ui.md)。
- [从 Warp 学到什么](warp-lessons.md) —— 四路调研的合并结论：退掉读屏、外部真相源当脊梁、`--session-id` 自己铸身份
- [别人怎么做的：happier 的 unified terminal](happier-unified-terminal.md) —— 同品类产品：也是读屏+敲回车+按版本存屏幕 fixture；输入仲裁器 1148 行
- [Claude Code Mods（function hooks）](claude-code-mods.md) —— 官方要把 hook 换成 TS 函数；我们注入的观察插件以后能省掉「每个事件起一次进程」，但等它发了再动
- [为什么 roost 的界面「不像现在的前端」](ui-language.md) —— 骨架是对的，皮肤选错了：纯白强调色、只有两档字号、正字距
