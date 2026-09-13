# omp transcript 接入与前端交接

日期：2026-09-09。补充并更新 `omp-readonly-sync-acceptance.md` 的消息覆盖范围；旧 OSC 回放协议继续有效。

后续已新增 [耐久历史与分页](ai-history-implementation.md)：长期历史不再受此文所述实时缓存上限限制，详情请用新的 history/messages 接口。原实时 snapshot/WS 和文件详情接口保持兼容。

## 本次实现

新包 `@roost/ai-transcript` 负责文件发现、增量读取、omp JSONL v3 适配和按需详情；业务后端负责定时调度，`ai-session-bridge` 负责消息与读取检查点一起持久化到现有 SQLite 记录。没有增加数据库服务或修改前端。

路径链路：OSC `transcript_path` → AgentEvent.transcriptPath → 自动 binding.transcriptPath。用真实 omp v18.1.11 检查 session_start / prompt_submit / stop，三者均未携带该字段。因此缺省按 nativeSessionId 在 `~/.omp/agent/sessions` 及下一层目录寻找 `*_ID.jsonl` 或 `ID.jsonl`，再校验文件 session header 的 ID 和版本。多个候选、超过 10,000 个目录项、版本不支持均明确降级，不猜文件。可用 `ROOST_AI_TRANSCRIPT_ROOTS` 指定搜索目录（平台路径分隔符分隔）。已经绑定的路径不会因文件搬家自动猜新位置。

每秒每会话读取一批，正文每批最多 256 KiB；每次另读最多 64 KiB header 和 64 字节检查点尾部。offset、未完成行的原始字节、文件标识和标准化消息一并提交；提交失败不推进已保存游标。单行上限 1 MiB，跨批次 UTF-8、半行、超长行都有处理。文件替换、截短和检测到的原地修改触发重读；这不是任意文件改写的完整变更检测器。

## 消息与回退

- transcript 可用时，正文使用 transcript；OSC 保留状态、权限提示和回退正文，避免同一问答显示两遍。
- 初次接入、文件重读、降级或恢复时，WebSocket 推送 `ai-session-snapshot`。**收到快照必须替换现有列表，即便 generation 未变**，不能追加。
- GET 增量读取的 `resetRequired: true` 同样表示需替换列表；后端已返回当前保留的可见事件。
- 正常新增记录仍用 `ai-session-event`；状态沿用已有 `ai-session-sync`。
- 文件不可读或格式不支持时切回保留的 OSC 消息；恢复后再切回 transcript。OSC 本身只有轮次边界，回退不代表完整中间过程。
- 现有缓存上限仍为 4096 条 / 8 MiB，淘汰或解析缺项通过 hasGap 表示。它不是无限历史档案，也不是分支树重建。

支持的角色：user / assistant / system / tool（omp toolResult）。消息仍为 `type: "message"`，兼容 content 展示，同时增加：

```ts
data: {
  source: "transcript",
  nativeMessageId: string,
  parentId: string | null,
  parts: Array<{
    type: "text" | "thinking" | "tool_call" | "tool_result" | "tool_error" | "unsupported",
    text?: string,
    toolCallId?: string,
    name?: string
  }>,
  truncated: boolean,
  detail: object // 后端维护的定位信息，前端无需解析或回传
}
```

普通正文预览最多 64 Ki 字符；工具结果预览最多 4000 字符，工具参数提供命令/路径摘要。thinking 只来自 CLI 已写入文件的内容。providerPayload、签名等未透传。未知内容块使用占位提示，未知记录计入 skippedRecords；不宣称已完整支持所有版本、分支、compaction 或图片。

## 前端需要接的内容

1. 按 parts 渲染文本、可折叠的已记录思考、工具调用和工具结果；使用 toolCallId 关联。现有 content 可作降级展示。
2. 增加可选的 `sync.transcript` 类型和状态提示：

```ts
{
  mode: "osc" | "transcript",
  status: "reading" | "caught_up" | "awaiting_line" | "partial" | "unavailable",
  reason?: string | null,
  offset?: number,
  fileSize?: number | null,
  skippedRecords?: number,
  coverage?: "recorded_supported_entries"
}
```

`caught_up` 仅表示已读完当时的文件；`partial` 表示有未支持或跳过的记录；`awaiting_line` 表示等待 CLI 写完一行。字段缺失时保持旧后端兼容。

3. 展开截断内容时调用：

```http
GET /api/ai-sessions/:id/transcript/:eventId?generation=当前generation
```

eventId 需要 URL 编码。成功 `{ event: 标准化消息 }`，详情文本最多 256 Ki 字符，仍需检查 truncated。后端从已保留消息找到文件位置，校验文件标识、原生会话 ID、记录 ID 和内容 hash；不会使用前端传入的文件路径。已淘汰的事件 404，generation 过期或文件变化 409。保持原 code 化错误形状。

## 验证及运行边界

- 新包验证跨批次读取、半行/UTF-8、超长/未知记录、替换/截短、详情变更、版本与会话校验、发现歧义。
- 后端验证 SQLite 检查点恢复、写入失败重试、OSC/transcript 切换去重、旧 generation 拒收、WebSocket 替换快照、详情 HTTP 与 409。
- 真实 omp 隔离测试通过：3 条 OSC、2 条 transcript 消息，HTTP/WebSocket/SQLite 可读；网关停机期间补收通过，daemon instance 保持。独立临时数据目录和端口，未重启日常 daemon。
- 真机测试命令：`ROOST_VERIFY_OMP=1 ROOST_OMP_WORKTREE=/tmp/diy-omp-readonly-sync node --import tsx --test backend/tests/omp-live.test.ts`。

部署这些业务代码后，已识别为 omp 且已有 nativeSessionId 的绑定即可尝试发现文件。旧 daemon 未透传 transcript_path 不阻塞这条发现路径；旧 daemon 的 OSC 断线补收能力限制依然存在。

本轮不包含有正文时自动换绑、历史代际归档、其他 CLI transcript 适配，以及浏览器内权限批准。权限选择继续交给原终端，不猜按键。
