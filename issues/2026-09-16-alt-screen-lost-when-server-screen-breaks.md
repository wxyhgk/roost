# 服务端网格坏掉时，重放会丢掉「正处在备用屏」这件事

**状态**：未修（2026-09-16 查证）。是**降级路径的降级路径**，不是主路。
**影响**：服务端那份解析好的屏幕拿不出来时，重放退回发原始 chunk。如果进入备用屏的那条
`?1049h` 已经被内存上限挤出环外，客户端就会在 **normal buffer** 里画 TUI 的整屏输出——
回滚被 TUI 的画面盖掉，而且 TUI 退出时不会像正常情况那样把 normal buffer 还回来。

标注 **[实测]** 的是本次跑出来的，其余为推断。

---

## 一、主路为什么没事

`createReplayStore` 默认带服务端网格，重连时发的是**当前画面重新序列化**出来的快照，
而不是原始历史。实测 `SerializeAddon` 排出来的形状是
`normal 回滚 → \x1b[?1049h → alt 内容` [实测]，备用屏状态自带，不需要任何 fold 去补。

客户端那边 `createResume` 在写全量基线前先 `sink.reset()`，引擎的 reset 里 `term.reset()`
会回到 normal buffer [实测]，所以快照自带的那条 `?1049h` 是真的生效、真的清空 alt buffer。
这条组合行为现在被 `frontend/tests/resume-altscreen.test.ts` 钉住了。

顺带排除了 tty7 记的那个坑（`research/tty7-lessons.md` 零件 3）：roost 的模式 fold
（`packages/terminal-runtime/src/mouseModes.ts`）刻意只管 9/1000/1002/1003/1005/1006/
1007/1015/1016，**47/1047/1049 不在 `MODES` 里**，全仓库也没有任何地方无条件发
`?1049h` [实测，grep 过 packages / frontend / backend / stable-workbench]。

## 二、漏的是哪一条

`replay.ts` 的 `full()` 里，`best` 为 null 时退回 `state.history` ＋ 原始 chunk。对一个
**没有历史的活会话**（`history` 是空串），发出去的就是裸 chunk。两种触发：

- 网格自己坏了——`screen.ts` 里任何一次 `write`/`serialize` 抛异常都会把这个 id 标成
  `broken`，此后 `snapshot()` 一直返回 null
- `grid.seq < state.floor`——网格的解析进度落后于环的淘汰进度。刷屏时有可能

这时如果 TUI 是在被挤掉的那段里进的备用屏，重放数据里就没有 `?1049h`。帧上 `truncated`
会是 true（UI 知道自己看到的不全），但「现在在备用屏」这个状态是丢的，不是截断的。

## 三、为什么没顺手修

补法是照 `mouseModes` 的样子再记一份备用屏状态，重放时在**环自己补不上**的前提下补一条
`?1049h`——注意必须是「环里没有才补」，补重了就正好踩进 tty7 那个坑。

代价在热路径上：那份状态得在 `append` 里逐块扫，而 `append` 就在 PTY 的数据回调里。为一条
「降级路径的降级路径」给每一个字节加一遍扫描，不划算。

真要修，更好的方向是让网格**别那么容易坏**（`broken` 是一个进程生命周期内不可逆的闸），
或者坏掉之后重建一份，而不是在重放这一端打补丁。
