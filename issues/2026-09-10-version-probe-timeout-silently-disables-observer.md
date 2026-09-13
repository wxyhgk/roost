# `--version` 探测超时会静默关掉 CLI 观察者集成

**状态**：机制已证实，未修
**影响**：机器一忙，启动 claude / opencode / qwen 时观察者集成会**静默**不装上——
终端里 CLI 照跑，但应用跟不上它的对话，而且没有任何提示。

标注 **[实测]** 的是本次跑出来的，其余为推断。

---

## 一、怎么发现的

`npm run verify` 满载跑全套测试时，`packages/terminal-daemon/tests/opencode-launch.test.ts`
红了一次：

```
✖ ordinary OpenCode receives a process-local additive TUI config and explicit loopback port
  actual: undefined,  expected: 'http://127.0.0.1:41986'
```

单独重跑三次全过。**但它不是「偶发的测试」，是一条真实的时间竞态被测试碰到了。**

## 二、机制（已证实）

`packages/terminal-daemon/src/opencode-launch.ts:31`：

```js
let observe = /* 一堆静态条件 */;
let version=''; if(observe){ try{ version=(spawnSync(executable,['--version'],{timeout:1500}).stdout??'').trim() }catch{} }
observe = observe && version === '1.18.29';
```

`observe` 为假就不会注入 `OPENCODE_TUI_CONFIG` / `ROOST_OPENCODE_ENDPOINT`，也就没有观察者。

而 `version` 变空有两种完全不同的原因，代码里**分不出来**：

1. 版本确实不匹配（我们只认 1.18.29）——这是设计意图，该静默降级
2. `spawnSync` 超时 / 出错——这是意外，却走了同一条路

**[实测]** 把假 opencode 的 `--version` 拖到 1800ms（超过 1500ms 上限），
启动结果里 `ROOST_OPENCODE_ENDPOINT` 直接消失，输出 `{}`——与测试观察到的 `undefined` 一致。

1500ms 在真实机器上并不宽裕：被探测的可能是一个 Node CLI，光进程启动就要几百毫秒，
机器一忙（本仓 `npm run verify` 会并行跑多个 workspace 的测试）很容易越线。

## 三、同一道门有三处

| 文件 | 超时 |
|---|---|
| `packages/terminal-daemon/src/claude-launch.ts:42` | 1500ms |
| `packages/terminal-daemon/src/opencode-launch.ts:31` | 1500ms |
| `packages/terminal-daemon/src/qwen-launch.ts:36` | 2000ms |

三处都是 `try{…}catch{}` 吞掉异常、把结果并进同一个「版本不对」的判断里，失败方式相同。

## 四、可能的修法（未定）

- **把「超时/出错」和「版本不匹配」分开。** 前者不该静默——至少写一行 stderr，
  让用户知道观察者为什么没装上。这一条不管选哪种方案都该做。
- **缓存探测结果。** 同一个可执行文件的版本不会在两次启动之间变，按 mtime + 路径缓存，
  绝大多数启动就不必再探。
- **放宽超时**（治标）：只是把窗口推远，机器足够忙时照样会踩。
- **改为异步探测、探到再决定**：改动大，且启动路径本来就要同步决定要不要注入环境变量。

## 五、给测试的说明

`opencode-launch.test.ts` 现在依赖「1500ms 内能起一个 Node 子进程」。修好之前，
它在满载 CI 上会偶发红。**不要靠调大测试里的超时来掩盖**——那正是被测代码的缺陷本身。
