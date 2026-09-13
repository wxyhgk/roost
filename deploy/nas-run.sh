#!/bin/sh
# 群晖宿主机源码直跑：依赖 /app 为镜像导出的现成目录（含 node_modules 与前端 dist），无需编译。
# 前提：Node.js v22 套件 + npm（见 deploy/README.md 源码部署章节）。
NODE_BIN=/var/packages/Node.js_v22/target/usr/local/bin
APP=${ROOST_APP:-/volume1/docker/ai-coding-web/app}
DATA=${ROOST_DATA:-/volume1/docker/ai-coding-web/data}
export PATH="$APP/tools/npm/bin:$NODE_BIN:/usr/bin:/bin"
export ROOST_DATA_DIR="$DATA"
export ROOST_OPEN=1
export BACKEND_LAUNCH=tsx
cd "$APP" || exit 1
exec node deploy/static-server.mjs >>"$DATA/nas-run.log" 2>&1
