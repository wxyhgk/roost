# 部署到群晖（DS720+，x86_64）

架构：静态前端 + 业务后端(8787) 跑在同一进程组，对外唯一端口 8080。
静态服务把 `/api/*`（含终端 WS）反代到后端，浏览器只访问 8080，天然同源。
数据在 `./data`（session 记录、终端归档），工作文件在 `./work`，另挂载了
整个 `/volume1`（容器内同路径）和家目录快捷方式 `/nas-home`。

安全现状（已确认接受）：`ROOST_OPEN=1`，无登录鉴权，仅放局域网。
不要做外网端口映射；群晖防火墙建议只允许内网网段访问 8080。

## 两种跑法

- 容器跑：`docker-compose up -d`，日志 `docker logs ai-coding-web`。
- 源码直跑（当前在用）：宿主机 Node.js v22 套件直接跑 `app/` 目录。
  `app` 由容器一次性导出（含编好的 node_modules 与前端 dist），宿主机无需编译器：

```sh
# 群晖上（PATH 先加上 ContainerManager 的 docker）
docker cp ai-coding-web:/app /volume1/docker/ai-coding-web/app
```

`app/deploy/nas-run.sh` 即启动脚本：用套件 Node 跑 `static-server.mjs`，
后端经 `BACKEND_LAUNCH=tsx` 直接起（宿主机无 npm）。两种跑法共用 `./data`，
切换时先停一方再起另一方。

日常启停（ssh）：

```sh
/volume1/docker/ai-coding-web/app/deploy/nas-run.sh  # 前台，可 Ctrl-C 停
# 后台跑：nohup /volume1/docker/ai-coding-web/app/deploy/nas-run.sh >/dev/null 2>&1 &
# 停：pkill -f "stati[c]-server"
```

开机自启（DSM 控制面板 → 任务计划 → 新增 → 触发的任务 → 开机）：
用户选你自己的账号，任务设置粘贴
`nohup /volume1/docker/ai-coding-web/app/deploy/nas-run.sh >/dev/null 2>&1 &`。
日志在 `./data/nas-run.log`。

## 验证

```sh
curl http://YOUR_NAS_IP:8080/healthz
curl http://YOUR_NAS_IP:8080/api/health
```

浏览器打开 http://YOUR_NAS_IP:8080（或 http://YOUR_NAS_HOST:8080），
新建 session 时 cwd 填 `/volume1/GitRepo` 这类真实路径，文件树即为群晖上的文件。

## 更新

本机改完源码后：

1. 小改（只动 `backend/src`、`frontend/src`、`packages/*/src`、`deploy`）：
   打包对应目录传到群晖 `app/` 下覆盖；若动了前端，需重跑前端构建
   （宿主机无 npm，进容器执行）：
   `docker run --rm -v /volume1/docker/ai-coding-web/app:/app -w /app node:22-bookworm npm run build --workspace frontend`。
2. 依赖变化（`package-lock.json` 更新）：群晖上重建镜像再 `docker cp` 全量导出：

```sh
# 群晖上
cd /volume1/docker/ai-coding-web/src && docker build -f deploy/Dockerfile -t roost:1.0 .
```

备份：停服务后拷走 `./data`（内含 workspace.sqlite 与终端归档）。
