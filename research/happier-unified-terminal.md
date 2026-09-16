# 别人怎么做的：happier 的 unified terminal

2026-09-15。材料：`research/third-party/happier`（Mobile/Web/Desktop client for Claude Code、
Codex、OpenCode、Pi、Cursor）——**和 roost 同一个品类，源码早就在仓库里**。

这份只回答一个问题：**「从 GUI 往一个活着的 Claude TUI 里发消息」，别人是怎么解决的？**

---

## 一、结论：没有绕法，他们和我们选了同一条路

`apps/cli/src/backends/claude/unifiedTerminal/claudePromptSubmitVerification.ts` 的模型是：

- **提交前**：读屏，确认正文已经在输入框里（原文匹配 **或** 折叠标记）
- **提交后**：读屏，确认它**不在了**。还在 = 没提交成功

也就是**读屏 + 敲回车 + 再读屏验证**。而且屏幕 fixture 是**按版本存的**：
`packages/tests/src/testkit/providers/claude/screenFixtures/claude-2.1.170/`、`claude-2.1.173/`
（tmux 抓的真实画面）。

**这和我们的版本钉子是同一个病**，不是我们做错了什么。四路调研的结论——
「`\r` 是一个没有寻址的字节，唯一能知道收件人状态的办法就是看屏幕」——在这里得到独立印证。

## 二、规模本身就是结论

```
createClaudeUnifiedInputArbiter.ts   1148 行
```

**输入仲裁器一个文件 1148 行。** 这件事不是「加一个闸门函数」就完了。同目录下还有 30 个
文件，逐个对得上我们正在做或讨论过的东西：

| happier | 对应我们的 |
| --- | --- |
| `createClaudeUnifiedInputArbiter.ts` | 我们要做的闸门 |
| `ownComposerDraftGuard.ts` / `ownComposerDraftClassification.ts` | `terminal_draft` 那道闸 |
| `claudePromptSubmitVerification.ts` | 转录逐字节比对（他们主要靠读屏） |
| `acceptedPromptTranscriptDiscovery.ts` | 转录回执 |
| `createClaudeUnifiedPendingQueuePump.ts` | `ai-command-owner` 的 pump |
| `injectionFailurePolicy.ts` | 失败模式表 |
| `dialogChoice/` | **「blocked 时让路」的另一种解法：从 GUI 直接答那个对话框** |
| `createClaudeUnifiedHookLifecycleBridge.ts` | 我们的 hook → agent 事件 |

## 三、他们有两套后端，正是我们面对的岔路

1. **`unifiedTerminal/`** —— 真 TUI，用户也看得见。就是上面这套。
2. **`sdk/query.ts`** —— 程序化驱动，`args.push('--permission-prompt-tool', 'stdio')`
   （`:340`），走 stream-json 输入，**没有 TUI、不需要读屏**。

两条都修了。对应到我们的语言：第二套是「P3 有寻址的原生通道」，第一套是 P1。

`permissionRequestSource.ts` 里两个来源并列，说明这两条路在他们的模型里是一等公民：
`claude_local_permission_bridge` 和 `claude_unified_terminal_dialog_choice`。

## 四、立刻能用的一条：Claude 会把多行粘贴折叠掉

`claudePastedTextMarker.ts`：

```
[Pasted text #1 +12 lines]
```

**粘贴多行时，Claude 的输入框显示的是这个标记，不是正文。** 他们用行数把它对回 prompt，
容差是 `-2 / +3`，并且注明**足够大的单行粘贴 claude 会省掉行数**（`[Pasted text #1]`），
所以提交验证不能只认带计数的那种形状。

对我们的两处直接影响：

1. **刚做的 P2**（只放正文、不按回车）：用户发多行消息时，输入框里看到的会是那个标记而
   不是自己的原文。文案「已经放进终端的输入框，按回车发出」仍然成立，但用户可能认不出。
2. **`claude-screen.ts` 的草稿检测**：`[Pasted text …]` 会被当成 `terminal_draft`——这是对的
   （那确实是草稿），但我们**分不出「这是我们刚放进去的」还是「用户自己粘的」**。
   happier 用行数匹配来认领所有权，我们没有。

## 五、一处我们比他们强的

全仓库找不到 `tpgid` / `tcgetpgrp` / 进程组前台判断（唯一的 `foreground` 命中是 UI 的
前后台通知行为，无关）。**happier 没有前台归属闸**——也就是 claude 起了 `vim`（`git commit`）
或 `less` 时，他们靠的同样只有读屏。

我们 32c4d5a 那一步是这一块的净增量。

## 六、该怎么用这份材料

- **不要照抄。** 它是一个完整产品的内脏，1148 行的仲裁器背后是他们自己的状态模型。
- **值得当"失败模式清单"用**：`injectionFailurePolicy.ts`、`ownComposerDraftClassification.ts`、
  `claudeUnifiedPendingDeliveryBlockHandling.ts` 这几个文件名本身就是他们踩过的坑的目录。
- **两条现在就该跟进**：折叠粘贴标记（第四节），以及 `dialogChoice/` 那个思路——它比
  我们讨论出的「blocked 时关掉输入框让路」更进一步，是**直接从 GUI 答那个对话框**。

**许可证**：`research/third-party/happier/LICENCE` 第一行是「MIT License」。抄代码之前按它核；
这份笔记只记设计与行为，没有复制代码。
