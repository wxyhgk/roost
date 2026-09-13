# Claude TUI / GUI 双向同步：调研与推进建议

2026-09-09。后端范围；三位 subagent 独立只读调研，根代理整合。对照本地 Happier checkout `d06e287b`，本轮未启动 Happier、未改业务代码或重启服务。下文为建议，不是已实现 API。

独立报告：

- [Happier 发送机制](01-happier-send.md)
- [当前后端复用点与缺口](02-backend-gaps.md)
- [安全边界与验收矩阵](03-acceptance.md)

## 用户得到什么

左侧原生 Claude TUI 与右侧聊天界面操作同一个进程、同一个原生会话。任一侧提交的用户消息与 Claude 回答进入同一份历史；GUI 不单独调用模型，不启动第二个 Claude。不是要求两侧像素、光标、动画与每个 token 完全一致。

## 当前结论

有可借鉴实现，最适合本项目的是 Happier 的 gated unified terminal，而不是它另一条 local/remote 模式切换与 SDK resume 路径。我们已有 daemon 拥有 PTY、Claude 启动 hook、身份绑定、transcript 增量读取、SQLite 历史与 WS 推送；主要缺口是受控发送和可核实的接收结果。

第一步不要直接做一个 HTTP 接口拼接文字和回车。先做隔离的 Claude 发送可行性验证，证明空输入框识别、同实例写入、提交确认，再开放产品接口。

## Happier 真正值得借鉴的部分

- `apps/cli/src/backends/claude/loop.ts`：unified terminal 是单独受功能开关控制的分支；旧模式切换不能与它混为一谈。
- `apps/cli/src/backends/claude/unifiedTerminal/runClaudeUnifiedTerminalSession.ts`：通过 terminal-host adapter 对同一终端提交；区分写入授权、实际注入、Claude 接受与历史回显。
- `apps/cli/src/integrations/terminalHost/promptSubmitVerification.ts`：先核实文本进入输入框，再提交 Enter，并验证提交后状态。
- `apps/cli/src/backends/claude/unifiedTerminal/acceptedPromptDeliveryIdentity.ts`：优先用 delivery identity，另有规范化文本回退。文本相同本身不能证明是同一次发送。
- 对草稿、对话框、写入后异常有专门状态。某些 fallback 仍是启发式；我们不能把它宣传为严格安全保证，也不应第一版照搬自动清除输入框/自动按键重试。

以上路径均相对于 `research/third-party/happier/`。独立报告补充精确锚点。

## 我们目前缺什么

1. **发送目标要锁定**：webSessionId + terminalInstanceId + binding generation + nativeSessionId。仅查到“当前是 Claude”不够，同一 PTY 内可以切换原生会话。
2. **真正可写的证据**：working/completed、PTY 是否静默都不能证明输入框为空。现有 hook 只含 SessionStart/UserPromptSubmit/Stop，不知道用户未提交草稿或权限弹窗。浏览器旧 snapshot 也不是当前 PTY 的可靠状态。
3. **所有输入共用控制点**：当前 WS input 与 binary 都能写，串行链只在单个 socket 内。GUI 请求锁住自己，仍挡不住另一个标签页、图片粘贴或其他输入来源。
4. **daemon 写入有结果**：现有 client.writeSession 是无回包 notify；“HTTP 成功/WS 发出”不等于“写入活 PTY”，更不等于 Claude 已接受。
5. **请求到回执的关联**：当前 Claude hook 没有传 prompt 或 prompt ID。收到一条 prompt_submit，只证明有人提交，不能直接确认某个 GUI requestId。必须引入有界内容证据/原生消息 ID、提交前游标和独占窗口；无法唯一关联时保持不确定。
6. **失败后不能重发两遍**：需要 requestId 去重、请求正文指纹、写入边界和持久化状态。存储与 PTY 写入不可能成为同一 SQLite 事务，不承诺 exactly-once。

## 推荐阶段

### P0：先验证双侧内容一致

用隔离的真实 Claude 主会话做一轮带工具的简单对话，验证 TUI 输入、用户消息、回答、工具记录在 GUI 数据 API 上一致；刷新/网关重启不重复。已有真实验证只证明启动身份与网关恢复，不等于真实回答全链路验证。

### P1：验证安全发送的最小链路

先限制 Claude、普通文本、主会话、空闲且已证明空输入框；每个终端最多一条待确认发送，不做批量排队。

- 验证从 daemon 所拥有的实时输出得到足够可靠的 screen/composer 状态。可评估无界面终端解析器，但不依赖前端缓存快照，先实测后决定是否增加依赖。
- 发送前/写入前重验实例与身份；所有人类输入、图片插入和 GUI 提交经过同一个 daemon 协调点。终端协议回复须另行分类，不能随键盘锁一起阻塞。
- 对草稿、菜单、权限框、未确认屏幕状态不写入，返回明确原因，GUI 保留消息。
- 多行文本按适配器定义粘贴，禁止把 ESC 等控制字符当普通文本直接执行；回车提交与内容写入分阶段记录。
- 通过 hook + transcript 的新证据确认接收，区分“已写入”和“已接收”。不要拿超时当未发送，不能盲重试。
- 如果不能证明输入安全，这一阶段就明确不启用发送；继续可用的只读同步，不自动清空用户输入。

### P2：开放后端发送接口

以下仅为拟定契约，先通过 P1 再固定命名：

`POST /api/ai-sessions/:id/messages`

```json
{
  "requestId": "client-generated-uuid",
  "terminalInstanceId": "...",
  "generation": "...",
  "nativeSessionId": "...",
  "expectedInputEpoch": 123,
  "text": "普通文本"
}
```

通过预检/落库返回 `202` 表示已受理，不表示已发送；同 requestId 同正文返回同一任务，正文或目标不同返回冲突。查询接口及 WS 推送使用同一发送记录。

建议状态：`pending` → `writing` → `accepted`；分支 `blocked` / `failed_before_write` / `uncertain` / `cancelled`。`writing` 仅表示进入可能产生外部作用的边界；只有对应 hook/transcript 证据可推进 accepted。不得将发送任务本身当作第二条正式对话消息。

网关重启后从 SQLite 查询任务；daemon 重启后不重放旧 writing/uncertain 输入。不自动承诺离线排队发送；目标实例或 generation 改变时旧任务不得跟随新会话。

### P3：再扩展复杂交互

工作中排队或 steer、GUI 权限审批、斜杠命令、附件、子代理、多 CLI 逐项增加能力。不要因为 Claude 可用就给 Codex/OpenCode 打开同一按键注入实现；公共任务/去重/状态可共享，提交与接收证据仍按 CLI 适配。

## 代码归属建议

- `terminal-daemon`：活实例与输入所有权、写入 RPC、实例校验。
- `workspace-store`：发送请求和状态持久化；不和 transcript 正文表混在一起。
- 独立发送协调模块：检查 binding、requestId 幂等、状态推进、回执关联。先形成清晰模块边界，稳定后再决定是否拆新 package。
- Claude 适配器：输入框状态、文本粘贴/提交、hook 与 transcript 确认证据。
- `backend/server.ts`：薄路由和 HTTP 错误契约，不承担重试状态机。
- 前端后续只负责输入框、消息保留、提交与发送状态展示；本轮不改前端。

## 验收底线

- 同一请求重复提交只产生一个发送任务；同文本不同 requestId 不能错误合并。
- 同时从两个标签页或 TUI 与 GUI 输入，不得拼接成一条混合消息。
- 草稿/权限框/菜单/未知屏幕下不写，不清空已有输入。
- 换实例、/clear、/resume、generation 切换后拒绝旧目标。
- 写入前失败可安全重试；写入中/回车后断连无确认时显示 uncertain，不自动补发。
- 刷新后任务状态可恢复；GUI 临时气泡与 transcript 回显不重复。
- 测试覆盖多行/Unicode/粘贴折叠块、hook 丢失/迟到/重复、相同文本连续发送、错误 native identity。
- 真实 CLI 验收必须独立于 parser/IPC fixture；没有实际验证的能力不开放。
