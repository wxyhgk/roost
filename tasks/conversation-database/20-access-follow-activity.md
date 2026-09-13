# 登录、文件访问边界、终端跟随与最近活动排序

本文件交接本轮新增后端契约。主 Agent 已完成本批专项和全项目 `npm run verify`，退出码 0；具体结果及未验证范围见末节。本轮没有修改前端，也没有把这些变更启用到日常服务。

## 1. 登录入口与会话

正常 `backend/src/index.ts` 启动默认加载认证。首次在应用 dataDir 中创建随机密码文件 `auth-password`，以独占创建和权限 `0600` 保存；随后读取时检查文件类型、属主和权限，拒绝符号链接。密码只留在本机文件，不由 HTTP 返回、不写启动日志，也没有公开的获取初始密码接口。

本机管理员自行读取并保管该文件，前端只接登录表单，不做远程密码 bootstrap。`createBackendServer` 未传认证配置时受保护请求返回 503 `auth_unconfigured`，不会自动匿名放行；`auth:false` 仅供显式测试夹具使用，不是生产启动默认值。

### 1.1 前端请求

```http
GET /api/auth/session
```

这是公开的认证状态接口，仍受共同 Host / Origin 检查约束：

```ts
{
  configured: boolean;
  authenticated: boolean;
  expiresAt: number | null;
  secureCookie: boolean;
}
```

`expiresAt` 为 Unix 毫秒。未登录不在这个接口返回私人数据，而是 authenticated=false；configured=false 应显示后端认证未配置，不能继续尝试受保护 API。

原 `/api/health` 也已要求登录。前端未登录时的健康/登录探测应使用 `/api/auth/session`，不能把 health 的 401 误判成整个后端离线；公开探测不返回密码或私人工作区信息。

```http
POST /api/auth/login
Content-Type: application/json

{"password":"用户输入的密码"}
```

成功 200 返回同形状状态，并设置 `diy_session` Cookie，属性为 `HttpOnly; SameSite=Strict; Path=/`，默认还有 `Secure`。默认登录有效期 12 小时，登录态只保存在 HTTP 进程内。密码错误返回 401 `authentication_required`；过多尝试返回 429 `rate_limited` 和 Retry-After，前端不能自动无限重试。

```http
POST /api/auth/logout
```

退出返回 200 状态，清除 Cookie 并撤销该登录会话。前端不要自行在 localStorage 存密码或会话 token，也不能通过读取 HttpOnly Cookie 管理身份。

### 1.2 HTTP 重启、退出与 WebSocket

- HTTP 后端重启需要重新登录；它不因此停止独立 daemon 持有的 PTY。
- logout 或会话到期会撤销**该登录会话绑定的全部 WebSocket**，包括终端、文件监听和对话同步；后续收发也校验登录态。其他独立登录会话不是同一个 token。
- WS 断开本身不能让浏览器可靠区分登录到期和普通网络问题。重连前查询 `/api/auth/session`，需要时展示登录页；不要一直盲连。
- 已经通过入口认证并进入处理的 HTTP 写入，不承诺在随后 logout 时撤回。文件保存、入队或原生输入是否已完成，仍以各自响应/回执为准；不能把退出登录显示成“已取消所有工作”。

实现依据：[auth-config.ts](../../backend/src/auth-config.ts)、[auth.ts](../../backend/src/auth.ts)、[index.ts](../../backend/src/index.ts)。

## 2. HTTPS / Origin 部署契约

生产前端通过 HTTPS 访问，并使用 WSS 连接；推荐反向代理将页面、HTTP API 和 WS 暴露在同一站点。默认 Secure Cookie 依赖该传输条件。这个后端本身不是 TLS 证书或反向代理安装器。

允许的额外页面来源使用环境变量：

```text
ROOST_ALLOWED_ORIGINS=https://workbench.example.com,https://other.example.com:8443
```

每项必须是精确 HTTP(S) origin：包含协议、主机与必要端口，不包含路径、尾部 `/` 或通配符。配置在正常启动时读取；已有 `OPEN=1` 不再绕过 Host / Origin 检查。Origin allowlist、CORS 与登录分别校验，允许某个来源不等于匿名可访问。

若明确只在本地明文 HTTP 调试，可以设置 `ROOST_AUTH_INSECURE_HTTP=1` 取消 Secure Cookie 属性。这不加密网络流量，**不能据此宣称公网 HTTP 已安全**。本轮没有在日常服务设置该变量、部署 HTTPS 代理或更改访问地址。

前端优先同站代理；若使用允许的跨 origin API，fetch 需要正确携带 credentials，且仍受浏览器 SameSite Cookie 规则限制。不能通过让用户关闭浏览器限制或将密码放进 URL 绕开问题。WS 使用浏览器 Cookie，不新增 query token。

Host / Origin 拒绝目前由共同入口返回纯文本 HTTP 403，WS 升级也直接拒绝为 403，没有承诺 JSON error.code。前端保留 status / 非 JSON 兜底，将它与登录 401 区分，不做无限重登；有 `root_not_allowed` 等结构化 code 时再按具体原因处理，不解析英文句子猜测。

实现依据：[access.ts](../../backend/src/access.ts)、[server.ts](../../backend/src/server.ts)。

## 3. 文件 root 只允许已有终端的工作目录

文件接口不再接受任意绝对目录作为 root。root 必须与某个**仍有保存记录的终端**工作目录规范化后完全一致：daemon 在线时优先实际 live cwd；离线或无 live 数据时使用保存 cwd。通过 realpath 对照，访问子目录仍使用相对 path。

例如允许的 cwd 为 `/work/project`：

```text
root=/work/project   path=src/main.ts
```

不要改成 `root=/work/project/src` 来访问同一文件，除非该目录本身也是一个已有终端的 cwd。终端已删除、cwd 改变或 root 对应路径被替换后，需要重新确认可用 root。保留的关闭/离线终端记录可以提供 stored cwd，不以“此刻必须有活跃 PTY”作为唯一条件。

目录枚举、文件预览、raw、写入、文件操作、上传和文件监听统一经过该入口，之后继续使用各自路径逃逸校验。root 不被允许时返回 403 `root_not_allowed`；路径逃逸和文件读写错误仍用各自 code。

文件 watch：首次订阅校验 root，每次发送前复验，另在现有 2.5 秒扫描流程成功时复验（扫描失败时不承诺严格的撤销时限，发送前的独立检查仍执行）；不再允许已失去目录依据的连接长期保留。服务端内部用 canonical root 监听，但 `files-changed` 帧仍返回客户端请求时的 root，避免改变前端原有匹配键。撤权后关闭连接，前端刷新终端 cwd 后再决定是否重订阅。

这限制的是网页文件 API，**不是对终端或 AI 子进程建立文件系统沙箱**。终端本身仍按其 OS 权限运行；也不承诺在途、已获准执行的 HTTP 文件操作在 cwd 变化或 logout 后自动回滚。

实现依据：[file-access.ts](../../backend/src/file-access.ts)、[server.ts](../../backend/src/server.ts)、[file-upload.ts](../../backend/src/file-upload.ts)。

## 4. 根据终端确认当前对话

新增：

```http
GET /api/sessions/:terminalId/conversation
```

它返回该终端**当前经 daemon 核验**的对话位置，与已有反向定位 `/api/conversations/:id/runtime` 使用相同结果形状：

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

daemon 根据当前 owner/source/run/binding、CLI 与实际实例核验，HTTP 在 IPC 返回后再次检查，包含实际进程与所请求 terminal ID 一致性。200 是本次查询的位置，不是长期在线证明或写入授权；没有 query 参数，仅允许 GET。

此能力要求 daemon 支持 `terminal-conversation-v1`。旧 daemon、断线或暂不可用返回 503 `runtime_unavailable`，不会自动重启日常 daemon；否则会影响它持有的 PTY。未知终端返回 404 `not_found`；尚未识别出当前结构化对话、运行已变化或退出返回 409 `run_unavailable`；回收站目标返回 409 `conversation_trashed`。

### 4.1 跟随开关的前端接法

`followTerminalConversation` 的保存方式仍见 [长期对话管理](19-conversation-management.md)。后端不自动替前端切选择。

1. 开关为 false 时，切终端不改变已选长期对话。
2. 开关为 true 时，对当前选中 terminal 发起上述查询；只在 200 后使用其 conversationId 更新 selection。
3. 响应回来前再核对：开关仍为 true、选中 terminal 仍是发请求时那个、返回实例仍匹配当前连接。用户已切到另一个终端或手动改选择时，丢弃旧响应。
4. 409 时保留原对话页面并提示当前终端尚无可用身份；503 提示识别服务不可用。不能改用 `?terminalId=` 历史列表第一条代替当前身份，也不能清掉已保存历史。
5. 如需跟随同一终端内部 CLI/原生会话变化，可在已有状态刷新触发时重新核验；本接口不新增一个可任意自报身份的前端绑定入口。

二层自动换绑已在既有后端实现，本批不重复建立第二个识别器。前端只消费确认后的结果，不 POST 手工绑定与后台争抢身份。

实现依据：[conversation-runtime.ts](../../backend/src/conversation-runtime.ts)、[peer-delivery.ts](../../packages/terminal-daemon/src/peer-delivery.ts)、[daemon client](../../packages/terminal-daemon/src/client.ts)。

## 5. 对话列表按最近活动排序

```http
GET /api/conversations?sort=activity&limit=50
```

- `sort=created` 为默认值，保持现有客户端的创建时间排序。
- `sort=activity` 按最后已保存消息时间 `lastMessageAt` 倒序；没有消息则使用 createdAt，再按 id 确定相同时间的次序。不是按打开页面、当前 PID 或标题显示时间排序。
- 响应保持 `{items,nextCursor}`，可以与已有 q/projectId/terminalId/state 组合。未知 sort、重复 query 和无效数值返回 400。
- activity 游标携带本轮匹配集合的校验标记；分页期间匹配集合、消息/修订状态发生变化，返回 409 `list_changed`。前端重新请求第一页，不继续拼接旧页，以免漏项或重复。
- 切换 sort 或其他筛选要清空旧 cursor。created 模式维持原有分页兼容性，不将 activity 的快照校验强加给老客户端。

已有搜索仍是目录与保存文本搜索；搜索结果精确定位到某条正文的页面能力留后续单独处理，本批没有新增搜索定位接口。

实现依据：[conversations.ts](../../packages/workspace-store/src/conversations.ts)、[HTTP 路由](../../backend/src/conversations.ts)。

## 6. 前端需要完成的最小改动

| 项目 | 要做什么 |
| --- | --- |
| 登录页 | 先查 auth/session，提交 password，成功后加载 workspace；退出清理私人页面缓存与 WS。 |
| 401 / 503 | 401 保留未提交输入并请求重登；auth_unconfigured 是后端配置问题；runtime_unavailable 只影响实时定位，不能判定历史丢失。 |
| 403 | 区分来源拒绝与 root_not_allowed；修正部署 origin 或刷新工作目录，不无限重试。 |
| 409 | run_unavailable 保留页面；list_changed/history_cursor_expired/resync_required 分别刷新对应列表或快照；冲突不得静默覆盖。 |
| 文件 | root 使用终端当前允许的 cwd，子目录放 path；watch 撤权后按新 cwd 重新订阅。 |
| 跟随 | 用户启用后只用已核验当前身份切选择，异步响应检查终端/实例/用户选择是否已变化。 |
| 列表 | 显式传 sort=activity，处理分页过程中列表改变。 |

GUI 发消息仍走已有 inbox 接口，始终固定本次逻辑请求的 conversationId/requestId；登录、定位或选择偏好都不是强行写 PTY 的理由。自动启动/resume CLI、全部浏览器交互与公网 TLS 部署仍未由本批后端代码自动完成。

## 7. 验证状态

主 Agent 已执行完整 `npm run verify`，退出码 **0**，日志为 `/tmp/access-follow-verify.log`：

- backend：216 通过、7 跳过，共 223 项。
- workspace-store：94 通过、0 跳过。
- terminal-daemon：58 通过、2 跳过，共 60 项。
- 全 workspace 类型检查、测试、前端构建和包边界检查通过。

专项包含认证 12 项、认证配置 2 项、真实 WebSocket 认证 3 项（覆盖五种 WS 分支的退出/到期撤销）及文件 root 6 项。文件 watch 删除关联终端后关闭码 1008，未发出变化通知；撤权结果已有专项实测。上述专项已包含在相应套件中，不重复累加总数。

这些是源码/隔离测试与构建结果。没有部署或重启日常服务；前端登录交互、浏览器完整体验、公网 HTTPS/WSS 反向代理及日常 daemon 升级尚未验收。默认跳过项不能计入真实 CLI 或公网运行验证。
