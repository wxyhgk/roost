# OpenCode 显式绑定只读适配器

实现：`packages/ai-transcript/src/opencode.ts`；集成：`backend/src/ai-transcript-source.ts`。

绑定必须提供 `cliId: "opencode"`、明确的 `nativeSessionId` 和 `transcriptPath: "http://127.0.0.1:PORT/?directory=..."`。这里 transcriptPath 是 API 来源地址，兼容现有字段；checkpoint.adapter 为 `opencode-api`，state 存 snapshotHash/sessionIdentity/coverage。offset/fileSize 固定 0，不是字节游标。

只读取现有 server 的 GET `/session/:id` 与 `/session/:id/message?limit=100`。必须由调用方确认这是当前 TUI 所连接的 server；不扫描端口、不读取全局配置、不启动另一 server。官方说明 TUI 本身带 server，单独运行 `opencode serve` 会创建另一个 server：[OpenCode Server](https://opencode.ai/docs/server/)。本轮采用官方已明确的 limit 参数，不假设 after 游标可用。

每次最多 100 条、总 HTTP body 4 MiB、总超时 5 秒；不跟随重定向。校验 session ID、创建时间身份、message/part 的 session 和 message ID。同 endpoint 同 ID 但创建身份变更时拒绝继续。地址中拒绝凭据，只支持 directory 查询参数；鉴权 server 暂未接后端凭据配置。

这是一份有界快照，不是全历史保证。达到 100 条或有未知 part 时 status=partial；coverage 始终 bounded_snapshot。API 忽略 limit 返回超过 100 条则降级，不悄悄读取无限历史。快照 hash 检测同 message 的文本和 tool 状态变化，稳定 eventId 配合 reset 快照更新当前显示；SQLite 历史保留正文修订，因此历史分页中可能出现同 eventId 的多个修订。

保留文本、已有 reasoning、tool call/input/output/error；工具 callID 可关联。预览总正文 64,000 字符、详情 256,000 字符，其余标 truncated。详情随采集写入耐久历史，使用已有历史详情接口；不能把 API ref 交给文件读取接口。未实现 SSE、精确删除/回退历史语义、当前 TUI 自动选中会话跟随；server 故障降级不影响终端。

测试：本地 HTTP fixture 验证 stable ID 更新、工具详情截断、跨会话拒绝、endpoint 重用拒绝、上游大小/条数边界、unknown part；SQLite/source 集成验证快照替换与两份正文修订。未对用户正在运行的 OpenCode 会话操作；fixture 通过不等于真实 TUI 联调通过。
