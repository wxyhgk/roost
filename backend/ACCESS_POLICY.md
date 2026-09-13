# 本机后端访问策略

HTTP、OPTIONS 和 WebSocket upgrade 在访问存储或终端之前检查 Host 和 Origin。

- 默认 Host 只允许 `localhost`、`127.0.0.1`、`[::1]`，端口必须是后端实际监听端口。
- 默认网页来源允许 `http://localhost:5173`、`http://127.0.0.1:5173`，以及后端自身的本机 HTTP 来源。
- 不允许任意本机端口、不可信网页来源、`Origin: null`、异常 Host；拒绝返回 403。
- 无 Origin 的本机 CLI 可以继续使用。带 `Sec-Fetch-Site: cross-site` 且没有 Origin 的网页请求被拒绝。
- 合法跨域响应回显精确 Origin，带 `Vary: Origin`，不再使用通配 CORS。
- 当前 Vite `/api` 代理的 `changeOrigin: true`、HTTP 和 WS 转发方式兼容。

额外网页来源由后端启动环境变量 `ROOST_ALLOWED_ORIGINS` 指定，用逗号分隔完整 origin，
例如 `http://localhost:15173,https://dev.example.test`。不能包含路径、末尾斜杠或通配符。
这不会自动放开 Host。自定义代理需要将 Host 改写为后端地址。

这是浏览器来源边界，不是账户认证，也不阻止本机程序主动构造请求。保持默认回环地址部署。

## 慢连接

每个终端 WebSocket 的待发送数据（含下一帧）上限为 4 MiB。超过上限只释放该连接，
不暂停或结束共享 Shell。页面仍可用已有游标协议重连；历史超出保留范围时返回 `truncated`。
发送失败同样只清理当前连接。此上限限制用户态发送积压，不等于整个进程或内核 socket 的总内存上限。
