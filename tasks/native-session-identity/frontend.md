# 前端恢复接入与验收（2026-09-12）

已接入 README 中的 GET resume / POST reopen 契约。恢复请求仍只发送 `{resume:true}`，普通重启发送 `{resume:false}`；nativeSessionId 和命令由后端重新确认。

## 行为

- 终端退出且正在查看时查询恢复计划；页面隐藏、终端切走或开始重启后停止查询。
- `identity_syncing`、`source_unavailable`、初次尚无对话及暂时的网络错误：在 2、4、8 秒后重查，最多三次。单次 GET 超时 15 秒；随后可点“重新检查”。
- `identity_unconfirmed`、不支持恢复、缺少恢复信息：显示中文原因，保留手动检查与普通重启。已有“诊断 / 恢复”入口可检查终端连接。
- POST 失败使旧计划失效并重新查询；相同错误再次发生也刷新。查询和重试不会自动执行恢复命令。
- POST 响应丢失或另一客户端已启动时只重连视图一次，通过真实握手确认进程是否存在；不重发 POST。迟到、取消的 GET 不覆盖当前计划。
- 界面不显示内部 ID 或命令；中英文文案均已补齐。

## 验证

- `node --import tsx --test frontend/tests/resume-plan.test.ts frontend/tests/session-controller.test.ts frontend/tests/terminal-restart.test.ts`：35 通过。
- `npm run verify`：933 通过、10 跳过、0 失败；工作区类型检查、前端构建与包边界通过。跳过项包含下述显式启用的真实 CLI 测试。
- `ROOST_VERIFY_OPENCODE_RESUME=1 node --import tsx --test backend/tests/opencode-resume-live.test.ts`：真实安装的 OpenCode 1.18.30 验收通过。独立 XDG 目录、数据库、守护进程及工作目录；创建 A/B 两个原生会话，网关离线时切到 B，结束 PTY 后通过恢复接口启动新 PTY，观察实际 TUI 绑定到 B，并从原生服务重新读出 A/B 的历史标记。只使用本地 shell 打印命令，无模型请求。
- 浏览器夹具：`node --import tsx frontend/tests/browser/terminal-resume-server.mts`，打开 `http://127.0.0.1:5177/tests/browser/terminal-resume.html`。使用实际 TermView、控制器、请求与查询组件，模拟 HTTP/WS 故障；验证同步后自动显示恢复按钮、成功恢复一次 POST、409 后移除旧按钮并显示中文原因、手动检查与普通重启请求体。

真实 CLI 验收在本机独立环境完成；未对用户已有会话执行恢复。FR 部署仅重启 HTTP 网关，保留原守护进程与 PTY。

## 上线检查补充

FR 的全量验证同样是 933 通过、10 跳过。FR 上的独立真实 OpenCode 恢复测试另行启用并通过（约 44 秒）；首次发布只重启网页后端，原有 2 个 PTY 身份和 owner PID 均未改变。

弱网浏览器验收发现：登录成功后，旧 Cookie 发出的请求返回迟到的 401，会再次打开登录框。请求层现按认证代次隔离过期通知；成功登录、成功修改密码后，旧请求仍向其调用者返回错误，但不会撤销新登录。新请求的真实 401 仍正常提示重新登录，失败登录不会屏蔽过期通知。没有保存 Cookie 或密码。

补充验证：`frontend/tests/auth-session-epoch.test.ts` 3 项通过；前端全部 316 项通过，生产构建通过。密码设置浏览器夹具提供“模拟迟到的过期响应 / 释放旧 401”按钮，验证重新登录后收到旧 401 时仍保持登录。该补充只改前端，部署时校验后端及其依赖源码一致后切换静态页面，无需再次重启服务。
