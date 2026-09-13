# Warp 事件流与 TUI/GUI 共享模型调研

## 结论

Warp 将 PTY、终端解析器和 UI 订阅解耦：PTY 线程只负责读取/解析并向统一的事件监听器投递事件；TUI、GUI 或其他消费者订阅同一模型。高吞吐时采用非阻塞发送和专用 wakeup 通道，避免 `yes` 一类程序让 UI 被唤醒事件淹没。

## 源码证据

- `research/third-party/warp/crates/warp_terminal/src/event_listener.rs`
  - `ChannelEventListener` 统一封装 terminal event、application event、PTY 原始字节和 wakeup sender。
  - terminal/app 事件使用 `try_send`，队列满时记录 warning，不阻塞 PTY 线程。
  - wakeup 使用独立 `async_channel`；注释明确说明接收端会节流并合并连续唤醒。
  - 原始 PTY 字节通过 `async_broadcast` 广播；没有 receiver 时不分配 `Vec`，有 receiver 时使用 `Arc<Vec<u8>>` 共享数据。
- `research/third-party/warp/crates/warp_terminal/src/local_tty/event_loop.rs`
  - `EventLoop` 同时持有 PTY、解析器和 `ChannelEventListener`。读取与 ANSI 解析在同一事件循环中完成，避免不同 UI 各自解析导致状态分叉。
  - `READ_BUFFER_SIZE = 0x4000`，并用 `MAX_LOCKED_READ = 0x10000` 限制一次持锁处理量，给其他任务让出机会。
- `research/third-party/warp/crates/integration/src/test/session_restoration.rs`
  - 集成测试覆盖多个终端的持久化恢复，验证工作目录、shell 及后台输出等状态，而不只是恢复 UI 外壳。
- `research/third-party/warp/crates/warp_terminal/src/model/grid/*`
  - ANSI handler 通过同一个 event proxy 更新终端模型；视图读取模型，不直接拥有 PTY 生命周期。

## 对本项目的建议

1. 保留 `terminal-daemon` 作为 PTY 唯一所有者；HTTP/WebSocket 层只订阅 daemon 事件，不直接解析第二份 PTY 流。
2. 在 `session-registry` 中维护稳定的 session、PTY instance、CLI native session 三重 ID，并让 TUI 与 GUI 都按 cursor 订阅同一事件日志。
3. 事件发送采用非阻塞策略：每个 session 有界队列，满时丢弃可重建的 wakeup/原始字节，并保留结构化状态事件；通过 `seq`/`cursor` 让客户端重连补发。
4. 高频输出批量化（按字节数或短时间窗口合并），单次处理设置上限，避免 Node 事件循环被无限输出占满。
5. 原始 PTY bytes 只在确有订阅者时复制；GUI 优先订阅解析后的增量事件，TUI 继续订阅终端网格/渲染状态。
6. 重启恢复必须校验 cwd、shell、PTY instance 是否仍匹配；不匹配时恢复元数据但标记 offline，禁止把旧输入注入新进程。

## 最小落地顺序

先把现有 `ai-session-bridge` 的内存事件缓存改成每 session 有界 ring buffer，并为事件增加单调 `seq`；再由 daemon 输出适配器发布批量事件；最后增加 SQLite 快照和启动恢复。这样可以先验证背压、断线补发和 TUI/GUI 共享状态，再引入 CLI transcript 或 hook。
