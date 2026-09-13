# CLI transcript 扩展调研

调研日期：2026-09-09。范围：当前后端、Happier 本地 checkout、官方文档。只读调研，未运行真实 CLI、未读取用户聊天、未重启服务；以下接入方案均未做 live 验证。

## 结论

从使用者角度，目标是“我在左侧继续用原来的 CLI，右侧准确跟着这个会话”。这需要同时拿到 **终端实例、原生会话 ID、可读取的数据源**，不是加几个 JSON 解析器就能完成。

推荐顺序：Claude Code hook + JSONL → OpenCode 同一 TUI server 的 HTTP/SSE → Codex 明确绑定后的只读历史。若允许改 OpenCode 启动方式，让我们先知道 server endpoint 和 session ID，OpenCode 的结构化能力最完整，可以提前。Codex 任意已有 TUI 的自动身份关联仍须单独验证。

## 当前代码的实际边界

- `packages/cli-adapters/src/registry.ts:1-16` 的自定义配置只有名称、命令、识别规则、图标等；识别 `claude`/`codex`/`opencode` 只能证明进程种类，不能证明原生会话身份。
- `packages/cli-adapters/src/index.ts:1-20` 是纯兼容规则与图片插入策略，不适合直接放 fs reader、网络连接或 hook server。
- `backend/src/ai-agent-source.ts:68-80` 首次自动绑定依赖 `event.agent.sessionId`。新增 reader 后，没有 OSC/hook/受控启动证据的 CLI 依然不会自动绑定。
- `backend/src/ai-transcript-source.ts:14-35` 当前明确只支持 omp，发现和读取都是 omp 专用函数。
- `packages/ai-transcript/src/index.ts:6-15` 的 checkpoint/detail 都写死文件路径、字节偏移和 fingerprint；OpenCode API 的 message/part 游标不能伪装成这个结构。

## 能力与成本矩阵

| CLI | 推荐身份证据 | 正文来源 | 保留原 TUI | 最低成本与缺口 |
|---|---|---|---|---|
| omp | 现有 OSC sessionId + instanceId | v3 JSONL + nativeId 查找 | 已有路径 | 已实现；完善历史、分支和归档 |
| Claude Code | SessionStart hook 的 session_id、transcript_path，加我们终端实例关联 | 主会话 JSONL；子 agent 单独标识 | 可以，通过启动插件/包装器注入 hook | 低至中；需要 hook 接收与重启后重报，不能只扫描最近文件 |
| OpenCode | 已知 TUI server + 明确 session ID | HTTP message/part + SSE | 可以，必须连到该 TUI 的 server | 中；端口/实例发现、当前选中会话、新建/切换事件需验证 |
| Codex | 明确选择的 thread ID，或受控启动/可靠事件关联 | rollout JSONL；官方 app-server 读取存储 thread | 只读文件可保留；新 app-server 不等于接管已有 TUI | 中至高；自动发现身份是主要缺口，不能用 cwd + 最新 mtime 猜 |
| 自定义 CLI | 由提供者声明并验证 | 无适配器则只有终端 | 保持现状 | 默认不宣称结构化同步能力 |

## Happier 借鉴与不照搬的部分

引用基线：`research/third-party/happier` commit `d06e287b42e7b73a48159c21731d33d95e966801`。以下路径均相对此 checkout。

**Claude：先可靠身份，再读文件。** `apps/cli/src/backends/claude/claudeLocal.ts:102-129` 通过附加 plugin 注册 SessionStart/PermissionRequest，并指出 settings 槽可能被其他 wrapper 占用；`session.ts:852-881` 接收 sessionId/transcript_path 后验证路径和身份。我们借鉴启动作用域插件、生命周期身份和路径验证，不复制其远程执行、权限控制整套体系。插件覆盖 start/resume 后，还要验证 CLI 内部 clear/new/compact 的真实行为，不能把每次 compact 都当新会话。

**Codex：发现、历史分页、后续追读分开。** `apps/cli/src/backends/codex/directSessions/providerOps.ts:18-68` 分离 listCandidates/pageTranscript/readAfterTranscript；`pageCodexTranscript.ts:33-82` 实际优先找 rollout，找不到仅降级成 app-server metadata preview，绝非完整 transcript。其多 home 最新 mtime 选择不能直接用于我们的自动绑定：应固定启动时的 home/source identity，遇到多个候选返回歧义。

**OpenCode：复用原生 API，但不能照抄全量追读。** `apps/cli/src/backends/opencode/directSessions/createOpenCodeDirectClient.ts:7-24` 用 baseUrl + directory 构造 client；`readAfterOpenCodeTranscript.ts:18-43` 每次拿全部消息再用数组下标切片。这只能限制输出，不能限制上游读取成本；同一 message 的流式 part 原地更新也不能仅靠 nextIndex 发现。我们需按 messageId/partId 更新，SSE 断线后按能力做有界补查或明确 reset。

## 官方接口核对

Claude hook 输入包含 session_id、transcript_path、cwd；hook 会继承父进程环境，因此可把终端实例关联信息带到接收端。hook 返回会影响执行，观察 hook 应不阻塞、不修改决策。子 agent 身份与主会话必须区分。[Claude Code Hooks](https://code.claude.com/docs/en/hooks)

OpenCode TUI 本身启动 server，默认 endpoint 随机；可指定 hostname/port。另起 `opencode serve` 会启动另一 server，不能据此声称已同步当前 TUI。官方提供消息列表/详情、SSE、health version 与 OpenAPI `/doc`，可用原生结构化数据；Basic auth 凭据只在后端使用。消息列表文档只明确 `limit`，不能假设已支持通用 after 游标。[OpenCode Server](https://opencode.ai/docs/server/)

Codex 官方 `thread/read` 可以读取已存储 thread 而不 resume，也不会订阅事件。`thread/turns/list` 和 `thread/items/list` 已有分页，但属 experimental，后者还依赖存储支持；应探测能力，旧版回退。不要为了只读观察调用 `thread/resume`，更不能把新 app-server 的订阅当作已有独立 TUI 的 live 事件。[官方 OpenAI documentation：App Server](https://learn.chatgpt.com/docs/app-server)

这些官方来源证明“存在接入面”，没有证明本机安装版本及现有启动命令支持。实施前只读获取版本/协议 schema，随后在隔离会话做验证。不要以滚动官网的新接口作为最低兼容版本。

## 最小统一接口建议

第一轮在 `@roost/ai-transcript` 内拆 `providers/omp.ts`、`providers/claude.ts` 与共享有界 JSONL reader；加入第二种真实来源时再引入 provider registry。不要立即拆成四个 npm 包。

建议责任划分：

1. backend 负责终端关联、hook 生命周期、source resolver、重试和 bridge 事务。
2. transcript 包负责数据来源适配、增量读取、规范化、详情与解析版本，不负责决定“这个终端属于哪段对话”。
3. bridge 负责 generation、归档、稳定事件 ID、分页和 WebSocket 契约。

接口草案（仅设计，未实现）：

```ts
type SourceRef =
  | { kind: 'jsonl'; provider: string; nativeId: string; path: string }
  | { kind: 'opencode-api'; nativeId: string; endpointId: string; directory: string };
type Checkpoint = { adapter: string; version: number; state: unknown };
interface TranscriptAdapter {
  probe(source: SourceRef): Promise<Capabilities>;
  readAfter(source: SourceRef, cursor: Checkpoint | null, budget: ReadBudget): Promise<Batch>;
  readDetail(source: SourceRef, detailRef: string, budget: ReadBudget): Promise<Detail>;
}
```

`unknown` 必须由 adapter 在入口校验；checkpoint 包含来源身份和格式版本，不能跨 adapter 复用。detailRef 为后端解析的 opaque 引用，不接收浏览器任意文件路径/URL。规范化保留 provider、native message/part ID、parent、工具 call ID、source revision、truncated、coverage。OpenCode 的 message 更新要求 upsert/revision 语义；现有仅稳定 ID 去重的 append 行为不足，接入前需补齐或第一版明确只投递已完成记录。

## 版本、降级与验收

- 保留已验证 fixture 版本；不支持的行计入 partial，不支持的格式退出读取。OSC 存在才降级 OSC；其他 CLI 应显示 structured source unavailable，不能假造 OSC 正文。
- source/home/endpoint 改变会使旧游标失效；由同一 generation 切换规则处理，旧 reader 的异步完成不能写进新会话。
- Claude hook 只安装到我们控制的启动作用域，不覆盖用户现有 hooks；SDK 路线意味着改变 CLI 执行方式，不列入第一轮只读同步。
- Codex 保留 response_item/event_msg 去重、工具结果关联、child rollout、压缩/回滚 fixture；只读解析不等于保证看到所有隐藏推理。
- OpenCode 测试同 message part 更新、SSE 重复/乱序/断线、server 重启、端口复用、session切换、旧版缺接口、分页上限；不得将 A server 的同名会话绑定 B 终端。
- 所有 adapter 共同测试：两终端同 cwd、resume/new、旧实例延迟事件、半行 UTF-8、长行/大结果、文件替换、进度事务失败重试、重复重放、来源不可用后恢复、浏览器断线补收。
- 完成定义是隔离的真实 TUI → 身份证据 → 数据读取 → bridge → HTTP/WS 全链路；仅 parser fixture 通过不能宣布某 CLI 已支持自动同步。

建议首个交付限制为 **Claude 主会话只读同步**：保留原 TUI，能 start/resume，工具调用与结果正确关联，失败不阻断 CLI。OpenCode 与 Codex 先各做一个明确绑定的隔离验证，再决定是否扩展自动发现。
