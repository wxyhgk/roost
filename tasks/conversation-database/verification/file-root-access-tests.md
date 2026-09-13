# 登录与文件 root 范围：独立 QA

状态：独立专项最初 5/5 通过，追加已连接 watch 撤权回归后 6/6 通过。与 auth-routes 联合执行为 9/9，0 skip / 0 fail，约 2.73 秒；最终日志 `/tmp/auth-file-routes-final.log`。首次日志 `/tmp/file-root-access-initial.log` 保留，本次没有先红后绿的缺陷结论。

入口：[file-root-access.test.ts](../../../backend/tests/file-root-access.test.ts)。运行命令：

```sh
node --import tsx --experimental-test-module-mocks --test backend/tests/file-root-access.test.ts
```

测试创建临时 SQLite 与两个隔离目录，通过真实 HTTP 登录获取 Cookie；可控 runtime 只模拟 live cwd 和连接状态，不启动模型或日常 daemon。测试明确配置 `secureCookie:false` 用于临时 loopback HTTP，不冒充已验证生产 HTTPS。Cookie 仅保留在进程内，不输出、不写入证据。

## 已执行的覆盖

- 默认未配置认证拒绝受保护操作 503；配置认证后，登录前 GET workspace/health/conversations/status/preview/raw/list、PUT 保存、POST 创建、PATCH 重命名、DELETE 删除、创建终端和上传均返回 401。
- 登录前 PTY、session-status、files/watch 三类 WebSocket 返回明确 401；公开 auth/session 查询可用。
- 登录后的既存 session root 支持 preview/raw/list、root 内子路径、原子保存、目录/文件创建、重命名、删除、二进制上传与 watch 握手；指向同一 canonical 目录的 root 别名可用。
- 未注册的独立目录不能成为 root，preview/raw/list/write/create/rename/delete/upload 全部 403；未注册子目录不能直接用作 root，必须通过原 root 下的 path 访问。相应 watch 返回 403。
- `/etc` 只做 list/watch 拒绝检查，不读取其中内容。
- 授权 root 中的目录符号链接及 `../` 逃逸，在上述读写与上传操作中均返回 403；重命名到外部符号链接目录也拒绝。断言隔离 outside sentinel 的正文和目录条目保持不变，内部 rename 源也保留。
- 在线使用当前 live cwd，stored cwd 不额外授权；断线后只回退 stored cwd；删除 session 后撤销该 root 的读取与 watch 授权。
- 已连接 watch 在删除 session 后触发真实文件变化，收到 1008 关闭；撤权后没有收到 files-changed 帧，不能靠握手时的一次授权继续监听。

## 证据边界

本文件使用真实 HTTP/Cookie/WebSocket 与临时文件系统，但 runtime 连接状态和 live cwd 是可控夹具；未重启日常服务、读取私人内容或调用模型。

本次覆盖静态目录符号链接和每次请求的目录范围，不宣称所有文件系统 TOCTOU 竞态均已覆盖。watch 正向用例验证授权握手，变更通知功能由既有 watcher 测试负责；密码哈希、会话过期、CSRF 等认证细节由对应模块专属测试负责。主负责人统一执行完整回归，未在此重复启动大套件。
