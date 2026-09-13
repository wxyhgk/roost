# 终端渲染调查：恢复画面与实时画面的一致性

日期：2026-09-11。范围：源码检查、当前 Edge 页面诊断、独立解析器复现及现有浏览器压力测试。没有修改产品实现，没有重启终端守护进程或向用户 Shell 发送输入。

## 后续修复状态（同日）

用户随后批准统一 Unicode。服务端现已在首次解析前加载并启用 Unicode 11；前后端实际解析到同一份 `@xterm/addon-unicode11@0.9.0`。正式依赖、锁文件和边界允许列表已更新。

新增三组逐格往返测试，覆盖 Emoji/中文、定位、自动换行、备用屏及恢复后的增量输出。修复前定位和备用屏两组失败，修复后全部通过；terminal-runtime 全套 55/55 通过，runtime/daemon 类型检查和模块边界检查通过。下文 Unicode 偏差是修复前结果，现在运行脚本的 `unicode_same_grid` 两侧都是 `A🙂BX`、cursorX=5。

这次没有处理快照尺寸问题，也没有替换运行中的守护进程；当前会话尚未加载新服务端代码。下文的页面和压力测试数字属于初始调查，不能当作修复后的真实会话验收。

## 结论

复现了两个恢复路径缺陷：前后端字符宽度规则不同，以及快照原始网格尺寸没有传递到恢复端。它们能解释部分刷新、重连后的错位，但尚未确认就是用户本次所指的具体异常。

### 1. Unicode 规则不同：同尺寸也会恢复错位

- 前端 `frontend/src/features/terminal/xtermEngine.ts` 加载 Unicode11Addon 并启用版本 11。
- 服务端 `packages/terminal-runtime/src/screen.ts` 没有配置该插件；本地实测默认版本为 6。
- 同样的 80×24 网格，输入 `A🙂B`，再把光标定位到第 5 列写 `X`。
- 实时解析结果：`A🙂BX`，cursorX=5。
- 经真实 ScreenStore → ReplayStore → Unicode 11 终端恢复：`A🙂B X`，cursorX=6。
- 对照实验只把服务端也改成 Unicode 11，恢复为 `A🙂BX`，cursorX=5。

这不是字体画得宽一点：服务端缓冲区已经按不同列数解释光标操作。先统一两端 Unicode 配置，并加入含 Emoji、定位指令、换行的往返验证。

官方说明：Unicode11Addon 更新字符宽度规则，加载插件后还要显式激活版本。
https://github.com/xtermjs/xterm.js/blob/master/addons/addon-unicode11/README.md

### 2. 快照网格尺寸被丢弃

- `ScreenSnapshot` 有 `cols` / `rows`。
- `ReplayStore.resume()` 返回的 replay 只有 type、instanceId、seq、data、revived、truncated，没有传递快照尺寸。
- `ResumeSnapshot` 同样没有行列；前端按当前容器网格直接写恢复数据。
- hello 的行列仅用于连接层记录 lastSize，没有用于设置恢复时的解析网格。

独立样本：80×24 备用屏，第 1 行 HEADER，第 22–24 行 INPUT / BOTTOM_BORDER / STATUS。

| 恢复网格 | 结果 |
| --- | --- |
| 80×24 | 四行及光标位置保持一致 |
| 60×18 | HEADER 消失，底部三行移至 16–18 行，光标行由 21 变 15（零起点） |

这是裸恢复步骤的确定差异。实际 CLI 是否随后因 resize 重绘而纠正，取决于前台、焦点、尺寸通知和应用行为，尚未用用户会话验证。不能把它直接判为当前会话的唯一根因。

后续修复需要把网格和快照绑定；还要处理快照后追加输出、resize 的顺序，不能只加两个字段便宣称完整。应先在源网格恢复，再通过明确的尺寸同步阶段进入显示网格。

### 3. 当前守护进程早于部分修复

本次观测：终端守护进程 PID 80694，从 9 月 10 日 18:05:53 起运行，持有 9 个 live sessions。
`63bddf8` 在当日 22:10:49 把服务端回滚深度从 500 调到 2000。现运行进程早于该提交；没有构建版本接口，因此这里依据进程时间与源码历史判断版本漂移，没有把它当作精确构建标识。

`openTerminalDaemon()` 会连接已有 owner，HTTP 后端启动不会替换它。现有会话仍由旧进程持有，启动成功不表示新的服务端终端实现已加载。

## 当前页面与验证结果

- Edge 当前选中的 Claude 会话：WebGL；146×46；容器可容纳/实际 46/46；视口已到底；已解析/已收 8780/8780；队列 0；未冻结。检查时没有捕获到控制台警告或错误。
- 这些数字只能排除采样时的积压、视口偏离和几何裁剪，不能证明历史缓冲内容正确。
- 现有独立浏览器 `terminal-output-lifecycle.html`：24,001 帧；10,268ms；最终游标一致；队列 0；WebGL contextLosses=0；无异常；结束标记存在。
- 该压力测试包含持续写入、改尺寸、隐藏再显示，但主要断言末尾标记存在，并不证明每一行恢复正确。
- 聚焦测试 34/34 通过：resume-storm、resume-freeze、session-controller、terminal-fit、screen。现有测试通过，没有覆盖并否定上述往返偏差。

## 重复验证

项目根目录执行：

```sh
node --import tsx tasks/terminal-rendering/probe-snapshot.mts
```

脚本只创建独立无头终端和内存存储，不连接 PTY、WebSocket 或应用数据库；输出两组问题与同网格、同 Unicode 的对照结果。

后续优先级：统一前后端 Unicode；补齐恢复网格协议及顺序；再用用户明确的 CLI 和触发动作复现。不要把旧研究中的刷屏原因直接套到本次现象，也不要用强制抖动 PTY 尺寸掩盖问题。
