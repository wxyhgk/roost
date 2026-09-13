# 长期对话管理：独立选择、终端关联与当前位置

本批在已有独立目录、保存历史及收发件箱之上，增加对话选择偏好、终端历史关联和已核验的运行位置。后端实现及验证已完成，本文是前端对接契约。没有修改前端，也没有升级日常运行中的 daemon。

## 1. 用户看到的区别

`conversationId` 是长期对话地址；`terminalId` / `webSessionId` 是承载过它的终端 ID。一个终端可先后运行多条对话，一条对话也可以先后关联不同的终端或运行实例。

- 用户选择对话后，即使切换或删除终端，仍能看这条对话已经保存的历史。
- 从某个终端查看“它运行过哪些对话”，查询的是历史关联，不是假装这些对话都还在线。
- 用户点击“定位终端”时，再查询 daemon 当前核验的位置；旧历史里的 active 标签不能替代这一步。
- GUI 发消息继续提交到明确的长期对话 ID，是否实际投递由现有队列和运行校验决定。定位成功不等于获得写入授权，也不会绕过草稿、权限或发送开关。

## 2. 工作区选择偏好

`GET /api/workspace` 与 `PATCH /api/workspace` 返回的现有工作区快照新增：

```ts
{
  selectedConversationId: string | null; // 默认 null
  followTerminalConversation: boolean; // 默认 false
  // sessions、selectedId 等原字段保持
}
```

修改示例：

```http
PATCH /api/workspace
Content-Type: application/json

{"selectedConversationId":"长期对话ID","followTerminalConversation":false}
```

- 两个字段都可省略，省略保持原值。JSON `null` 清除对话选择，不是字符串 `"null"`。
- `selectedId` 仍表示终端选择，与 `selectedConversationId` 分开保存。后端不会因切换/删除终端自动改写对话选择。
- `followTerminalConversation` 只保存 UI 偏好。设为 true 不会后台猜一条对话、启动终端或发送消息；前端实现跟随行为时，仍需确定目标并显式更新 selectedConversationId。历史关联出现多个候选时不能直接选第一条作为当前身份。
- 偏好按最后一次写入生效，不使用对话元数据 revision。它是布局/选择信息，不能作为其他窗口发送消息的隐式目标授权。
- 未知对话返回 404 `not_found`；试图直接选择回收站内对话返回 409 `conversation_trashed`；错误类型/未知 workspace 字段返回 400 `invalid_request`。

回收站行为：已有 selection 的对话被移入回收站后，读取 workspace 时隐藏该选择，返回 `selectedConversationId: null`，但不会因此删除底层 selection meta。只要用户没有随后清除或选择另一条，恢复该对话后原选择会重新可见。归档本身不会隐藏已有选择。不要将读取返回 null 自动回写成清除偏好，否则会改变上述恢复行为。

实现依据：[preferences.ts](../../packages/workspace-store/src/preferences.ts)、[types.ts](../../packages/workspace-store/src/types.ts)、[store.ts](../../packages/workspace-store/src/store.ts)、[server.ts](../../backend/src/server.ts)。这些偏好由工作区接口读写；不要假设单对话 changes 一定发布偏好修改通知。

## 3. 按终端查询曾关联的对话

现有列表增加 `terminalId`：

```http
GET /api/conversations?terminalId=终端ID&state=all&limit=50
```

响应仍为 `{items: ConversationRecord[], nextCursor: string | null}`。查询匹配已保存的 generations 或 runs，终端记录已删除仍保留关联。一个终端切换 CLI / 原生会话后，可返回多条历史对话；没有关联时返回 200 空列表，而不是声称终端仍存在。

`terminalId` 可与既有 `projectId`、`q`、`state` 组合。`state` 默认 active，如需包含归档/回收站应明确用 all；active 是目录整理状态，不是运行状态。参数必须非空、最多 512 字符且不含控制字符；重复 query、空 cursor 或不支持参数返回 400。limit 仍为 1–200，默认 50。改变 terminalId 或其他筛选后重新从第一页请求，不能复用旧筛选的 cursor。

实现依据：[conversations.ts](../../packages/workspace-store/src/conversations.ts)、[HTTP 路由](../../backend/src/conversations.ts)。

## 4. 阅读运行与旧绑定历史

```http
GET /api/conversations/:conversationId/runs?limit=50
GET /api/conversations/:conversationId/runs?terminalId=终端ID&cursor=上一页游标&limit=50
```

只允许 `terminalId`、`cursor`、`limit`，limit 1–200、默认 50。响应为：

```ts
{
  items: Array<{
    id: string;
    conversationId: string;
    sourceId: string;
    provenance: 'run' | 'generation';
    runId: string | null;
    webSessionId: string;
    terminalInstanceId: string;
    generation: string;
    cliId: string;
    nativeSessionId: string;
    startedAt: number;
    endedAt: number | null;
    recordedState: 'active' | 'ended' | 'unknown';
    runtimeVerified: false;
    daemonInstanceId: string | null;
    ownerEpoch: number | null;
    reason: string | null;
  }>;
  nextCursor: string | null;
}
```

- 时间为 Unix 毫秒，按 startedAt 倒序及内部稳定次序分页。客户端把 item.id 视为不透明键，不解析它作为原生 ID。
- provenance=run 来自实际保存的运行观察；没有对应 run 的旧 generation 也会补入历史，runId/owner 字段为 null。旧 generation 没有结束时间时 recordedState=unknown，不推断 active。
- 同一终端实例和 generation 已有 run 时，不再额外重复展示该 generation 行。
- **所有行都固定 `runtimeVerified: false`**，即使 recordedState=active 也是过去保存的观察。该接口不询问 daemon，不创建或接管运行。
- 游标绑定 conversation、source 和 terminal 筛选，并固定本轮分页的插入上界。新观察不会在后续页突然取代先前的 legacy generation；想看新增运行需刷新第一页。
- 未知对话返回 404 `not_found`；错误/跨筛选 cursor 返回 400 `invalid_request`；历史上界失效返回 409 `history_cursor_expired`，应重新请求第一页。

实现依据：[conversation-links.ts](../../packages/workspace-store/src/conversation-links.ts)、[conversation-types.ts](../../packages/workspace-store/src/conversation-types.ts)。

## 5. 定位当前已核验终端

```http
GET /api/conversations/:conversationId/runtime
```

无 query 参数，仅 GET。200 响应为：

```ts
{
  conversationId: string;
  runId: string;
  webSessionId: string;
  terminalInstanceId: string;
  generation: string;
  cliId: string;
  nativeSessionId: string;
  runtimeVerified: true;
}
```

daemon 在这次请求内核对当前 owner、source、run、binding、终端实例与 CLI，并重新校验 generation → source 关联。HTTP 等待 IPC 返回后再检查当前对话、run、binding 和 live terminal，防止响应在途期间换绑后仍返回已失效的位置。此查询可以刷新运行观察，但不会启动/resume CLI 或发送输入。

200 只表示该次查询观察到的位置，状态随后仍可能变化。前端跳转时使用 webSessionId，并核对连接的 terminalInstanceId；不匹配就重新查询或显示运行已变化，不静默连接同 ID 的新实例。不要把返回值缓存成长期“在线证明”或永久写入许可。

| HTTP | code | 页面处理 |
| --- | --- | --- |
| 400 | `invalid_request` | 修正 ID 或移除 query 参数。 |
| 404 | `not_found` | 长期对话不存在。 |
| 409 | `run_unavailable` | 当前无可核验运行，或运行已变化；保留历史页面，不自动新开 CLI。 |
| 409 | `conversation_trashed` | 对话在回收站，先恢复后定位。 |
| 503 | `runtime_unavailable` | daemon 断线、旧版本不支持定位或运行查询暂不可用；不冒充“对话已删除”。 |

定位端点当前将未分类异常统一映射为 runtime_unavailable；其他独立历史/目录接口仍使用 storage_unavailable。不要依靠错误 message 的具体文字判断状态，统一形状为 `{error:{code,message}}`。

**新定位 RPC 需要升级 daemon 才可用。** 旧 daemon 返回 503，不会为了满足查询而自动重启或替换。本轮没有重启日常 daemon，避免终止它持有的当前 PTY；因此源码/隔离测试完成不等于日常服务已支持这个新端点。前端应保留只读历史和明确的暂不可定位提示，升级由独立发布安排处理。

实现依据：[conversation-runtime.ts](../../backend/src/conversation-runtime.ts)、[daemon resolve](../../packages/terminal-daemon/src/peer-delivery.ts)、[daemon client](../../packages/terminal-daemon/src/client.ts)、[ConversationRuntime 类型](../../packages/terminal-runtime/src/index.ts)。

## 6. 前端最小对接顺序

1. 从 workspace 读取两个新偏好，独立保存所选 conversation；保持原终端 selectedId 的语义。
2. 对话正文继续使用已有 `/snapshot`、`/messages` 和只读 stream。终端退出或绑定消失不清掉保存历史。
3. 从终端打开历史目录使用 `?terminalId=`；查看运行轨迹使用 `/runs`。不要把历史项的 recordedState 当在线徽标。
4. 只有点击定位时调用 `/runtime`，按返回实例核对终端位置。历史可读与终端可定位分别展示。
5. GUI 发信继续 `POST /api/conversations/:id/inbox`，使用本次用户明确选定的 conversationId 和持久 requestId。工作区偏好变化不能让正在重试的请求偷偷换收件人；不将正文绕过队列直接写 PTY。

发送、回执、原生历史去重与 changes 补收仍遵循 [G2 契约](09-g2-frontend-contract.md) 和 [MCP 前端补充](17-mcp-frontend-handoff.md)。CLI 已退出后的自动启动、resume、恢复选择器，以及完整浏览器界面都没有由本批接口自动实现。

## 7. 本批验收记录

2026-09-09：实现、独立测试和反方审查完成。`npm run verify` 退出码 0，包含全部工作区类型检查、测试、前端构建及源码边界检查；日志 `/tmp/conversation-management-verify.log`。

- 本次新增专项：选择偏好 7 项、历史关联 5 项、HTTP 集成 4 项、daemon 定位 7 项，全部通过。
- 全量相关包：workspace-store 86 通过；backend 189 通过、7 跳过；terminal-daemon 57 通过、2 跳过。跳过项不作为实测证据。
- HTTP 集成使用真实 HTTP / SQLite，模拟 CLI 运行状态，覆盖独立选择、删除后历史、分页、断线和异步查询期间实例变化。
- daemon 专项包含真实 Unix socket / PTY / SQLite；CLI 身份由测试模拟，没有调用真实 AI 模型。异常 PID 用例是超出 TerminalSession 类型的防御性数据测试，不代表已证实真实 daemon 会产生该数据。
- 独立记录：[QA](verification/conversation-management-tests.md)、[反方审查](verification/conversation-management-skeptic.md)。没有浏览器验收；日常 daemon 未重启，新定位能力须在安排升级后启用。
