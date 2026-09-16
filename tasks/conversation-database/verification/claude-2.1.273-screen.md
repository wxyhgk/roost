# Claude Code 2.1.273 的屏幕判定实测

2026-09-15。**只读验证，没有改任何代码**，也没有提交任何 prompt。

## 为什么要验

`ai-command-owner.ts` 的 `reason()` 把 claude 版本钉死在 `2.1.266`，其他版本一律
`unsupported_version`。这颗钉子是有道理的：往 TUI 里写字靠 `claude-screen.ts` 的
`classifyClaudeComposer` 用正则认屏幕，认错了可能把字敲在权限框上。

本机装的是 **2.1.273**，于是 GUI 发送在版本这一关就被挡下（另一关是
`ROOST_CLAUDE_GUI_SEND` 没设，见 `tui-gui-sync-implementation.md`）。

## 怎么验的

把 claude 真起在一个 80×24 的 PTY 里（`zsh -i -l -c`，与 `shellArgs` 同形），把字节喂进
**生产路径本身**——`createClaudeScreen(80,24)` 然后 `inspect()`，而不是直接调
`classifyClaudeComposer`。这个区别是决定性的，见下面「一次读错」。

## 结果：三支都判对

| 场景 | `createClaudeScreen.inspect()` | 期望行为 |
| --- | --- | --- |
| 空输入框（仓库目录） | `empty` · settled | 允许写入 ✓ |
| 启动时的信任目录对话框 | `dialog` · settled | 拒绝写入 ✓ |
| 敲了字但没回车 | `terminal_draft` · settled | 拒绝写入 ✓ |

结构假设逐条成立：光标行匹配 `^(\s*)❯[  ]?(.*)$`；上下各一条 80 字符 `─` 边框；
页脚含 `shift+tab`。对话框那支同时命中三个特征（`trust this folder`、`Yes, I trust`、
`Esc to cancel`），不是靠单一字符串撑着。

顺带一个对安全有利的观察：信任框默认高亮的是 `❯ No, exit`，不是「信任」。

## 一次读错，值得记下

第一次我直接调 `classifyClaudeComposer(lines, y, x)`，用了 `mutedPlaceholder` 的默认值
`false`。于是占位符 `Try "fix lint errors"` 被当成正文，判成 `terminal_draft`，
看起来像「2.1.273 不通过」。

真实路径里那个标志是 `inspect()` 按单元格颜色算出来的（暗色/灰度/调色板 8,240-245）。
**结论从「不通过」翻成「通过」，差的只是一个参数。** 验证这类门禁时必须走生产入口，
自己拼参数调内部函数会得到一个看似合理的错误答案。

另外：真实受控路径里 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` 会被设上
（`claude-launch.ts`），占位符根本不出现，`empty` 判定只会更稳。

## 没覆盖的（不要当成全面通过）

- 跑起来之后的「思考中」画面——那条走 hook 的 `working`，不经过屏幕判定。
- **会话中途的权限框**：只验了启动时的信任框。两者文案未必一样。
- 窄终端：边框正则要求 `[─━]{8,}`，很窄的终端可能不满足。
- 其他占位文案：只见到 `Try "…"` 这一种形状。
- 只在一台机器、一个终端尺寸上跑过。

## 结论与建议

2.1.273 上这三支判定与 2.1.266 一致，**没有发现放宽版本钉子的技术障碍**。

但建议不要把 `'2.1.266'` 直接换成 `'2.1.273'`——那只是把钉子挪一格，claude 每升一次级
就再卡一次。建议改成一份**验证过的版本清单**，并让 `unsupported_version` 的提示说清
「看到的是哪一版、验过的是哪些」。

这属于改写入闸，未经明确同意不要动。
