# 真实 HTTP / WebSocket 登录生命周期：独立 QA

状态：[auth-routes.test.ts](../../../backend/tests/auth-routes.test.ts) 首跑 3/3 通过；与文件范围及 watch 撤权测试联合执行 9/9，0 skip / 0 fail，约 2.73 秒。日志 `/tmp/auth-routes-initial.log`、`/tmp/auth-file-routes-final.log`。

本测试使用真实 Node HTTP server、ws 客户端、临时 SQLite 与正式认证模块；PTY 使用 FakePty，不调用模型或日常 daemon。登录通过正式 POST /api/auth/login 取得真实 opaque Cookie，Cookie 只在进程内使用，断言也避免打印其值。临时 loopback HTTP 明确 secureCookie:false，不代表生产 HTTPS 验收。

## 已验证

- 同一登录会话连接五种正式 WebSocket 入口：PTY、session-status、files/watch、ai-sessions events、conversation stream。除正常无初帧的 watch 外，均检验相应真实初始帧，PTY hello 精确匹配实例与 PID。
- PTY ready/replay 后，授权 input 确实写入 FakePty。POST logout 随即使全部五种连接关闭；注销响应之后尝试发送的旧连接输入未进入 PTY。
- logout 后旧 Cookie 的 HTTP 以及全部五种 WS 入口均拒绝 401；新登录可以重新连接五类流，PTY PID、instance 和创建数量不变，重新连接不会产生额外输入。
- 用实际 2000ms session TTL 定时器让全部五类流过期关闭，未调用虚拟时间或直接 revoke。PTY 保留且 writes 不变；旧 Cookie 401，新登录接回相同 instance。
- 无配置 factory 的 HTTP/WS 均 503；正常配置但缺 Cookie 的 HTTP/WS 均 401。
- 设置 OPEN=1 后，外部 Origin 的 Cookie HTTP/五类 WS 仍拒绝 403；Cookie WS 缺 Origin 同样拒绝，Cookie PATCH/logout 缺 Origin 拒绝 403。被拒绝的 logout 没有提前撤销合法会话。OPEN 原环境值在结束时恢复。

## 边界

这是正式 server/认证/WS 接线的动态证据，超出了只测认证模块的 fakeSocket；但底层 PTY 仍是可控 mock，因此不能声称已经验证真实操作系统进程或模型恢复。会话过期只证明本次短 TTL 样本；不推导长期运行、反向代理或 TLS 配置正确性。密码哈希、并发登录、容量与请求大小等继续由认证单测负责。

主负责人在新增测试冻结后统一执行完整回归，本报告不替代全量结果。
