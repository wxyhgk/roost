# Access / File scope / Current conversation / Activity 独立反方

日期：2026-09-09。状态：本轮后端范围限定放行；不等于浏览器登录、公网 TLS 或多用户权限验收。

仅审查与受控本地反例，不改业务/测试/前端，不操作模型、私人会话或日常服务。

## 冻结检查

- 默认未配置 auth 的 server 拒绝 API；auth:false 必须显式且仅用于测试。生产随机密码文件权限0600，不打印凭证；session token随机不透明、内存期限、重启失效。
- 登录、session查询边界独立；其余HTTP必须auth。Origin/Host检查不能因OPEN变量绕过，cookie认证不能只靠CORS阻止跨站写入。
- 三类WS（terminal、AI events、conversation）统一握手认证，异步attach前复核；logout/expiry主动终止该token全部WS，不能仅禁止新握手。已经在处理中的命令不冒称已撤销。
- 文件root/path必须服务端授权并防符号链接逃逸；上传/写入/读图/preview/目录操作/history一致。CLI图标与附件是应用受控目录，不应被任意客户端路径替代。手动transcriptPath/detail另需核范围，不因主文件API已保护就遗漏。
- current conversation由当前daemon/instance/binding/source核验，不以历史run.active或用户偏好代替；activity读接口不能触发launch/send或泄漏未授权会话。
- 实际测试与假runtime/合成事件边界明确。新认证导致旧fixture失败应显式auth:false，不可退回生产默认允许。

## 独立审查结果

本轮没有发现尚未修复的阻塞问题。独立阅读 `auth.ts`、`auth-config.ts`、`access.ts`、`server.ts`、`file-access.ts`、`file-upload.ts`、`conversation-runtime.ts` 与 store activity 分页实现。

- HTTP 统一入口先 Host/Origin，再 auth 路由与 require；OPTIONS 是无资料的预检。未配置工厂默认 503，生产 index 显式加载密码文件，`auth:false` 只存在显式测试入口。原 OPEN 开关不能跳过边界。
- 密码使用随机盐 scrypt 固定长度比较；登录有地址、全局、并发与 body 时间/大小限制，不信任 X-Forwarded-For 作为限流身份。cookie 不透明随机、HttpOnly/SameSite=Strict，默认 Secure；session 不持久化。此结论不包含真实浏览器是否接受当前部署 cookie。
- 所有实际 WebSocket upgrade 分支走统一二次授权与 bindSocket，包含 PTY、AI events、conversation stream、status、file watch。异步 file root 检查后还要再握手授权。logout/expiry 删除 token 并终止 socket，发送/接收也检查当前 token；gateway dispose 保留已有 restart close frame，250ms 有界终止。
- `/api/fs/file` 上传虽然是 POST，仍经过统一 URL root 授权，未遗漏；PUT file 与文件操作 body 分别验证 root。realpath 将目录别名归一，已授权 root 的子路径另做路径/符号链接检查。目录列表此次也检查实际目录，避免 symlink 直接列出根外内容。
- terminal current conversation 通过 daemon 当前 run/binding/source/instance 核验，HTTP await 后再次比较；不使用最近历史项或 selection 当当前身份。不能把这个瞬时定位响应当后续写入的授权。
- activity 查询和指纹在同一 SQLite 事务快照中，稳定 ID 次排序；翻页期间匹配集合、消息序号、epoch 或 revision 改变会返回 409 list_changed，而不是静默漏项。默认 created 顺序保持。该接口不启动模型/终端。

## 独立执行证据

仅临时数据库、fake PTY/runtime 与本次隔离 HTTP/WS，没有操作日常服务或模型。

1. `node --import tsx --experimental-test-module-mocks --test backend/tests/auth.test.ts backend/tests/terminal-conversation.test.ts backend/tests/conversation-activity.test.ts`：16 pass，0 fail/skip；包含审查期间新加的两条 auth dispose 回归。
2. 同命令运行 `backend/tests/file-root-access.test.ts`：5 pass，0 fail/skip。包含未认证无文件副作用、正常保存/上传/watch、陌生 root、子目录提升 root、符号链接/遍历逃逸、cwd 在线与离线回退、session 删除后的新请求拒绝。

总计独立 21 项通过。认证细节测试使用假 WebSocket 对象检查 emit/send 栅栏；file-root 测试使用真实隔离 HTTP/WS 握手。不能据此声称已逐个真实 WS 类型做过 logout/expiry 网络实验，也没有声称全仓测试由本报告重跑。

## 不能扩大解释的边界

- 这是单一已登录管理员访问边界，不是文件沙箱或多租户隔离。管理员可创建任意 cwd 的终端，终端本身按操作系统身份执行；手工 transcriptPath 绑定也是独立管理能力。cwd 限制避免文件 API 自己接受任意根，不声称限制管理员终端权限。
- 追加源码复核：watch 每次发送前重新 canonicalize requestedRoot 并检查当前 cwd 授权，不再仅在握手检查；2.5 秒扫描成功结束时也检查现有 watcher，失效以 1008 关闭并注销 watchAccess。保留 requestedRoot 原字符串兼容前端。扫描失败或阻塞不承诺严格 2.5 秒撤销时限，但实际发送路径仍独立核验。cookie 撤销仍关闭连接。
- 已被授权且进入处理的 HTTP 写入，不因随后 logout 就声称撤回。WS 新消息被阻止，不能把认证失效当已落库命令取消。
- Secure 默认 true；HTTP 部署要显式 `ROOST_AUTH_INSECURE_HTTP=1` 才使用无 Secure cookie。本报告未修改用户环境，未验收 TLS、反向代理、浏览器跨源 credentials 或前端登录界面。
- activity 变化会要求从第一页刷新，这是明确一致性取舍；持续写入时不承诺旧分页游标一直有效。


## 最终追加证据（未重复执行）

已只读检查最新 `attachFileWatch`、`watchAccess` 扫描/清理及新增专项：删除 session 后既有 watch 收到 1008、没有撤权后通知。QA 报告见 [file-root-access-tests.md](file-root-access-tests.md) 与 [auth-routes-tests.md](auth-routes-tests.md)：真实五类 WS 认证专项 3 项及 file-root 6 项，共 9/9 通过。这些属于 QA 执行结果，不计入上面的独立 21 项。

root 报告全量 `npm run verify` 退出 0：backend 216 pass / 7 skip，store 94 pass，daemon 58 pass / 2 skip。本报告不将 skip 算作真实模型或浏览器通过。
