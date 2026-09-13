# Codex rollout 只读适配（2026-09-09）

已实现 `readCodexTranscript(path, nativeId, previous?)` 与 `readCodexDetail(ref)`；入口通过当前 `session_meta.payload.id` 验证明确绑定。没有扫描最近文件、按 cwd 猜会话，也不会启动另一 app-server 然后声称订阅了原 TUI。

## 数据与界限

- 读取 `response_item` 中 message（user/assistant/system/developer）、function/custom tool call 和 output、公开 reasoning summary。工具通过 call_id 关联；不交付 encrypted_content 或任意原始 payload。
- `event_msg` 用户/助手镜像不输出第二次正文，跨批次也不会重复。只有镜像而无 response_item 的旧格式不补造正文；覆盖声明是 recorded_supported_entries。
- 缺少 payload.id 时使用文件字节 offset 作源记录 ID，普通追加、checkpoint 恢复和同文件重放稳定；源文件改写会 reset，不能承诺重排后身份不变。
- compaction、rollback、未知 item/event 等计入 skipped，状态 partial。当前提供已记录事件的顺序，不声称精确还原回滚后的活动分支；child rollout 不跨原生会话合并。
- 每次最多读取 256 KiB 数据，加 64 KiB 头部验证和 64 字节尾部校验；单行超过 1 MiB 跳过，下一行可恢复。半行以原始字节保存，UTF-8 不截坏。
- 预览用户/助手最多 64 Ki 字符，工具结果 4000 字符；详情最多 256 Ki 字符。详情和 checkpoint 同批交给 bridge，落库后不依赖源文件继续存在。
- checkpoint 带 `adapter: codex-rollout`；detail 带 `provider: codex`。其他适配器的 checkpoint 不复用。

## 联调

后端来源 registry 使用 `cliId: codex`，必须提供 `nativeSessionId` 和明确的 `transcriptPath`。头部不匹配报告 session_mismatch；没提供文件报告 explicit_source_required。结构化来源能力不代表已经有自动终端身份发现。

由调用方先掌握可信的原生会话 ID/rollout 路径，再绑定。App Server 的 thread/read 属于另一种可能的只读来源，本文没有实现该通道，也没有调用 thread/resume。[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 验证证据

本机只读版本检查：codex-cli 0.153.4。格式 fixture 参考仓库 Happier 的 `codex.localControl.mirroring.slow.e2e.test.ts` 和 `directSessions.codex.browseTail.feat.sessions.direct.e2e.test.ts` 中无用户数据的测试记录。

- `node --import tsx --test packages/ai-transcript/tests/codex.test.ts`：4 项通过，包含镜像去重、工具关联、详情、半行 UTF-8、限额、身份拒绝、未知 compact/rollback、文件替换。
- `node --import tsx --test backend/tests/codex-transcript-source.test.ts`：2 项通过，明确绑定→来源轮询→snapshot→SQLite 历史与源删除后详情；缺失/错误身份不导入。
- 未读取个人聊天或凭据，未运行真实模型请求，未验证独立 Codex TUI 自动绑定。未重启日常 daemon。
