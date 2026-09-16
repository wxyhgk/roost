# 输入延迟：先量，再改

跨太平洋用 roost（客户端和服务端隔一个大洋，走 Tailscale）时打字明显有延迟。

## 先确认延迟是什么

```
tailscale ping <Windows 客户端>   via DERP(lax)  212 / 170 / 403 ms   direct connection not established
tailscale ping <另一台 Mac>       via DERP(lax)  ~194ms 稳定
tailscale ping <同城路由器>       via DERP(lax)  ~201ms 稳定
```

**~200ms 是物理。** 跨太平洋单程约一万公里，光在光纤里跑一趟 50ms，往返 100ms 是下限。
代码改不动它，只有本地回显能对抗。三台全都没建立直连、走 DERP 中继——中继落在服务端同城，
不加多少距离，但加抖动（那台 Windows 170→403 的摆动就是"有时候特别卡"的来源）。

## 三个猜错的假设

动手前猜了三个，抓包之后全死了。记在这里是因为它们都"听起来很有道理"：

1. **「AI CLI 用 DEC 2026 同步输出，把本地回显关掉了」** —— claude 2.1.273 整段捕获里
   `?2026h` 出现 **0 次**。
2. **「claude 在备用屏里跑」** —— `?1049h` / `?1047h` / `?47h` 各 0 次，它跑在普通缓冲区。
3. **「每次按键那四个 `\r\n` 会滚动缓冲区，viewport 一变就丢信任」** —— 回放真实字节，
   `baseY=0 viewportY=0` 全程不变。

## 怎么量的

在 PTY 里起一个 claude，按计划打字，录下带时间戳的原始字节。**不发 API 请求、不耗额度**，
只是本地 TUI 渲染。

```js
const term = pty.spawn('claude', [], { cols: 100, rows: 30, cwd: <已信任目录>,
  env: { ...process.env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' } });
term.onData(d => chunks.push({ t: Date.now() - t0, data: d }));
```

然后把这串字节喂进 `@xterm/headless`，按 `localEchoView.read()` 同构地造 `EchoLine`，
再驱动真实的 `createLocalEcho()`：按键时先 `input()` 看 `view()` 有没有覆盖层（此刻回显
还在路上），然后喂回显、`observe()`。**这样量出来的是「这一下按键用户能不能立刻看见」**。

## 量到的

一次 14 键的真实输入（hello、停 3.5 秒、 world、三次退格）：

```
修之前  12/14 立刻可见
修之后  13/14 立刻可见
```

唯一剩下的未命中是**每轮第一个字符**，那是设计使然：`trusted` 要等一次确认过的回显才
建立，否则密码提示那种不回显的地方会被预览出来。这条不该动。

修掉的那一次是**行尾空格**。claude 对行尾空格只回 `ESC[1C`——光标右移一格，一个字符都
不写，屏幕文字和上一帧完全相同。而「终端真的回显了」的证据原来只认文字变，于是空格
掉信任，下一个字符等一整个往返。正常行文每 5、6 个字符一个空格，200ms 链路上就是每六
次按键卡一次。

证据放宽成「可观测状态变了」（文字**或**光标）。这对密码框仍然安全：不回显的提示符连
光标都不动，而判定还要求光标正好落在预测位置上。见
`frontend/src/features/terminal/engine/localEcho.ts` 的 `echoed`，回归测试在
`frontend/tests/local-echo.test.ts`。

## 还没做的

- 第一个字符仍然要等一个往返。要省掉它就得在没有回显证据的情况下预览，那会碰到密码框，
  不该为了 200ms 去赌。
- 粘贴（>32 字符）和方向键、回车一律不预测，跨洋链路上这些都是满 200ms。
- 没有任何**线上**的输入延迟测量。诊断面板报了 `renderer` 和 `contextLosses`，唯独没有
  「按键到回音多久」——没有这个数，下一次改动说不清有没有用。
