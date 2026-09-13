# 弱网部署后的下一轮改进审查

日期：2026-09-12。按用户要求，由 4 个 subagent 分别审查连接生命周期、终端数据流、后端资源、部署与载荷；主代理补充 FR 现场只读采样并汇总。本轮不修改产品实现、不重启服务、不向用户终端发送输入。隔离复现使用假 Socket、内存文件系统或合成数据，不能当作用户现场已经发生的证据。

## 当前基线

- FR 当前 release：`20260911T235958Z-network`。web PID 2019541、owner PID 1776261，均 active，自动重启计数 0。
- 采样时 web RSS 164016 KiB，inotify 监听项 7；最近 15 分钟日志中 `terminal daemon unavailable`、`timed out`、`Error:` 均为 0。此前 432733 个监听项的资源问题在当前样本中没有再出现。
- 本机向 FR 的 HTTP 登录状态接口发起 8 次独立连接，8 次均 HTTP 200；总耗时最小 295 ms、中位数 330 ms、最大 356 ms。样本很短，且不是用户浏览器链路，不代表丢包率或长期稳定性。未用服务器全局累计 TCP 重传计数估算本应用丢包率。
- 已存在：同尺寸不重复 resize、Unicode11、带网格的回放、原位置预显、回放分批、终端 45 秒握手/60 秒回放等待/30 秒心跳超时、连续失败后 30 秒恢复探测、静态 gzip/zstd、Ketcher 按需 iframe。后续实验应建立在这些能力上。

证据级别：**现场**表示本轮读取了生产入口或进程状态；**隔离复现**表示实际源码在受控夹具中表现出该行为；**源码**表示尚未测量用户影响；**待测假设**表示仅应先测量。

## 优先处理：恢复过程的正确性

### 1. 统一慢客户端恢复与前端回放协议（隔离复现）

后端 [server.ts:848](../../backend/src/server.ts#L848) 会在慢客户端积压下降后，在同一连接补发第二份 `replay`。前端 [connection.ts:212](../../frontend/src/features/terminal/connection.ts#L212) 却把握手后的任何 `replay/catchup` 当作非法帧并断线。

实际 `createConnection` 接受 `hello → replay(seq=1) → replay(seq=20)` 的结果：`framesAccepted=[replay]`、`socketCloseCalls=1`。第二份基线没有进入解析器。

另一个恢复漏洞：[replay.ts:159](../../packages/terminal-runtime/src/replay.ts#L159) 按 UTF-16 字符数保存增量，[terminalTransport.ts:32](../../backend/src/terminalTransport.ts#L32) 按实际 JSON UTF-8 字节限制 4 MiB。150 万汉字的合法 catchup 实传 4500122 B，发送被拒；同状态完整屏基线仅 155 B。[server.ts:882](../../backend/src/server.ts#L882) 发送失败直接返回，没有切换基线，重连可能不断请求同一份发不出去的增量。

**最小改动**：明确运行期重设基线的协议；按实际传输字节预算选择增量或完整屏。保留实例、序号、解析屏障和输入时机校验，不能靠取消校验或截断 ANSI 流解决。

**验收**：把现有 [backend-hardening.test.ts:124](../../backend/tests/backend-hardening.test.ts#L124) 的慢消费者接到真实前端连接器；测试中文和密集 ANSI 大回放。额外断线数为 0、最终已解析序号一致、恢复完成可输入、健康观看者不受影响。成本中；必须明确完整屏回退时较早滚动历史的取舍。

### 2. 断线输入绑定 CLI 代际，并让待发送状态可见（隔离复现）

[connection.ts:80](../../frontend/src/features/terminal/connection.ts#L80) 会保存断线期间最多 32000 字符，包含回车和控制键，恢复后自动发送；第 187 行只比较 PTY 实例。

隔离实验：Claude 断线期间排队 `synthetic-confirm\r`，同一 PTY 以 OMP 身份恢复后，该输入自动进入 OMP。这直接对应“退出 Claude，再启动 OMP”的使用场景；本轮没有向真实 CLI 发送该内容。

**先做**：显示待发送数量、允许取消、设置有效期；CLI 代际改变或目标不确定时，不自动投递旧输入。仅比较 CLI 名称还不能识别同类 CLI 的新会话。

**之后再评估**输入序号与 owner 接收确认。当前 `ws.send()` 成功只代表交给浏览器队列，不代表 PTY 收到；现代码没有盲重发已标记 sent 的输入。增加重发必须配合去重，接收确认也不代表命令执行成功。

**验收**：假 PTY 记录字节，在发送前、发送后和 CLI 切换时断线，检查丢失、重复和旧输入进入新 CLI 的次数。先做目标保护成本低到中；完整确认协议成本较高。

### 3. 修复新目录监听器的边界，并改善订阅范围（隔离复现）

[watcher.ts:87](../../backend/src/watcher.ts#L87) 的 `watch(child)` 与 `opendir(parent)` 共享 ENOENT 处理。子目录在扫描后恰好被删除，会误撤销仍存在父目录的监听，且不报错。夹具结果：打开 root、parent，关闭 parent，errors=0，room 仍存在。Git checkout、生成器和构建临时目录是可能的触发场景。

[watcher.ts:27](../../backend/src/watcher.ts#L27) 用 `path + sep` 判断后代；根目录 `/` 得到 `//`，退订后子目录监听泄漏。虚拟 `/ → home → project` 实验中 rooms=0、directoryCount=2；未实际监听生产服务器的 `/`。

**先修复**：分别处理父目录枚举与子目录建监听的错误；统一根目录也正确的路径包含判断。验收父目录继续收到事件，退订、报错、dispose 后所有句柄和预算归零。成本低。

**再优化 scope**：[watcher.ts:108](../../backend/src/watcher.ts#L108) 只对相同 root 去重，嵌套 root 会重复占预算。三个唯一目录、配额 4，先订阅祖先再订阅其项目，第二个 room 就会超限。先共享 canonical directory 的引用计数，再试只监听根目录与文件树已展开目录。验收监听数等于目录并集，大 `/root` 不挤掉小项目，展开时重新列目录补齐离线变化。

扫描还会在 [watcher.ts:96](../../backend/src/watcher.ts#L96) 对每个目录遍历全部 watcher keys，最坏接近 O(N²)；维护父子索引比继续提高 4096 上限更值得尝试。

### 4. 跨版本保留静态资源，错误资源不要回退 HTML（现场确认）

[fr.Caddyfile:9](../../deploy/fr.Caddyfile#L9) 将所有资源指向 current release，对 `/assets/*` 设置一年 immutable 缓存，并无区别回退首页。

现场请求用户日志中的 `/assets/main-BEQfsuec.js`，得到 **HTTP 200、Content-Type: text/html、长度 1013、Cache-Control: public,max-age=31536000,immutable**。这证明旧 JS 地址能收到被长期缓存的首页；未模拟真实旧浏览器的全部懒加载流程。

**实验**：hash 资源使用跨发布共享目录或保留可访问的旧资产；HTML 随 release 切换；`/assets/*` 缺失返回 404。保持旧页面打开，切新版本后第一次打开预览模块，验证旧 hash 返回正确 JS、虚构 hash 返回 404、草稿不因自动刷新丢失。成本低到中，需控制资源保留占用。

这一发布问题也见于 [Vite load-error handling](https://vite.dev/guide/build.html#load-error-handling)；[Caddy try_files](https://caddyserver.com/docs/caddyfile/directives/try_files) 的首页回退应限制在页面路由。

### 5. 对话断线续接与正文游标确认（隔离复现）

[conversations.ts:156](../../frontend/src/shared/api/conversations.ts#L156) 断开仅触发 onClosed；[ConversationDetail.tsx:95](../../frontend/src/features/conversations/ConversationDetail.tsx#L95) 只设置 live=false，不重建订阅。真实连接函数关闭后推进虚拟时钟 120 秒，socket 总数仍为 1。

同一组件第 86、99 行先推进游标，再抓消息正文，失败被转成 null。提取实际回调执行：正文读取失败后，后续仅游标推进，最终 cursor=c2、visibleMessages=0、fetchAttempts=1。**服务器保存的记录没有丢失，但当前对话视图可能长期漏掉最后一条更新。**

**实验**：分开已应用游标与待补读消息，成功合并后确认；断线从已应用游标续接，保留 resync_required 的重新快照流程。模拟 10% 正文读取失败、乱序与断网，最终前端消息 ID/版本应与快照完全一致，不需切换视图恢复。成本中，必须防旧对话请求串入新对话。

### 6. 工作区轮询只保留一个在途请求，阻止旧状态回写（隔离复现）

[store/index.ts:130](../../frontend/src/shared/store/index.ts#L130) 每 4 秒发请求，没有 single-flight 或卸载代次判断；[request.ts:16](../../frontend/src/shared/api/request.ts#L16) 对当前工作区请求也没有单独超时。[state.ts:180](../../frontend/src/shared/store/state.ts#L180) 直接回写 cwd、cli、cliId。

用实际 interval 回调挂起三个请求：maxInFlight=3，乱序结果被应用为 newest→oldest→middle。cwd 倒退又可能触发文件监听 root 切换。

**实验**：请求完成后再计时；初次读取与轮询共用去重、AbortController、销毁代次保护，后台暂停或降频。模拟每个请求 20 秒、乱序与卸载，验收并发始终 ≤1、旧结果不回写、cwd/CLI 不倒退。成本低，是值得尽早做的减负项。

## 下一组性能实验

### 浏览器解析队列总量与观看者流控（隔离复现）

[resume.ts:35](../../frontend/src/features/terminal/resume.ts#L35) 的 256 KiB 是单批大小，不是总队列预算；第 62 行持续追加 Promise 任务。将实际解析 sink 暂停后，64 个 256 KiB 块均被接受：队列 16 MiB、received=64、applied=0。

先记录待解析字节和最老任务年龄，再考虑按观看者反馈已解析游标及有界恢复。服务端 `bufferedAmount` 无法看到已被浏览器收下但尚未解析的积压。验收队列峰值、RSS、输出结束后追平时间；不能暂停共享 PTY 或任意丢掉 ANSI 块而影响其他观看者。成本中到高。

### 字体本地化、编辑器按需加载（源码与构建测量）

[frontend/index.html:11](../../frontend/index.html#L11) 依赖 Google Fonts 外部请求；[font.ts:35](../../frontend/src/features/terminal/font.ts#L35) 最多等字体 2 秒，晚到后会重新测量。试验自托管实际使用的 IBM Plex Mono 字重，保留等待机制，测字体域不可达时的可输入时间和重复 resize 次数；核实许可并保留字重、字体度量。

[Tree.tsx:12](../../frontend/src/features/files/Tree.tsx#L12) 静态引入预览弹窗，进一步带入 CodeMirror 与多种语言。可先把整个 FilePreviewModal 按需加载，比较首屏下载量和首次预览耗时。本地已有构建产物：主 JS gzip 651032 B，首页直接引用主包、共享包和 CSS 合计 gzip 748157 B，不含字体；这些数字不是 FR 全部页面加载流量。Ketcher 虽大，但已经按需 iframe 加载，不应重复算作首屏问题。

### 分阶段耗时与受控弱网验证（源码）

复用已有 [终端诊断](../../frontend/src/features/terminal/diagnostics.ts#L3)，记录字体等待、WS 建立、回放完成、可输入时间、应用心跳往返耗时；后端补充事件循环延迟分位数。无需增加一条轮询或采集终端正文。[Node 官方事件循环监测](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions) 可用于区分网络等待和进程忙碌。

在隔离环境测试固定延迟、抖动、短暂断网与突发输出；记录恢复时间 p50/p95、每分钟重连次数、输入重复/遗漏数和队列峰值。应用心跳包含两端调度时间，应称“端到端往返耗时”，不能直接当成纯网络 RTT。消息延迟模拟也不能等同真实 TCP 丢包实验。

### 各条流的恢复一致性与握手错峰（源码及内存模拟）

终端已经有慢速恢复，但 [fileWatch.ts:64](../../frontend/src/shared/api/fileWatch.ts#L64) 在临时失败 10 次后永久停止，手动刷新重启监听是已有能力；[session-status/connection.ts:9](../../frontend/src/features/session-status/connection.ts#L9) 仍采用最多 5 秒退避，且没有终端心跳的后台计时保护。

[sessionController.ts:289](../../frontend/src/features/terminal/sessionController.ts#L289) 唤醒时只检查 socket 表面 OPEN 状态；半开连接可能再等 15 秒才探测，加 30 秒超时。先尝试唤醒时非破坏性的 probeNow；区分临时网络失败与资源/权限拒绝，前者慢速恢复，后者保留手动退路。文件流禁止客户端消息，不能直接发送终端 ping。

每个终端都用确定的退避，同一故障后会同时重连。两条连接内存模拟的下一次握手均为 400 ms。可给新握手/回放设置小的页面级并发上限并加入随机错开，优先当前终端；不卸载后台终端或停止已建立连接。

验收后台/睡眠返回的首次探测时间、10 个终端同时断线后的握手峰值、前台恢复 p95、后台最终恢复公平性。已有 38 项相关聚焦测试通过，新增模拟不等同完整浏览器弱网验证。

### 大目录与同步存储预算（部分合成证据，部分待测假设）

[fs.ts:35](../../backend/src/fs.ts#L35) 读取完目录后在主线程映射和排序全部条目，再由 [server.ts:691](../../backend/src/server.ts#L691) 整体 JSON 序列化。实际 listDir 配合十万个合成条目：约 75 ms 列表处理、14 ms 序列化，原定 10 ms 的定时器在约 93 ms 才运行；列表时间包含夹具创建成本，不是 FR 现场性能。

先试条目/响应字节上限、明确 truncated 状态，以及大预览并发限制，测终端 echo 和事件循环 p95/p99。若需要分页，必须设计目录变化时的刷新语义。

[database.ts:27](../../packages/workspace-store/src/database.ts#L27) 使用 DatabaseSync 和 5 秒 busy timeout，HTTP 与 owner 共用数据目录。慢盘或写锁竞争阻塞 owner 是**待测假设**。只能在隔离数据库制造有限写锁并测量后，再决定短事务、批量写或存储 worker；不能只降低 timeout 后忽略持久化失败。

## 推进原则

先为已复现的跨层契约和监听边界补回归，再做小幅修复；随后测量需求范围、并发与队列预算，最后评估更大的协议或 worker 改造。继续沿用用户要求的 HTTP IP 入口；现有证据不支持把更换传输协议、全局调大超时、直接扩大监听上限作为首选方案。
