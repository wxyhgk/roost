#!/bin/sh
# 保活：健康则退出；否则清残留 backend 并拉起。给 cron 每 5 分钟跑。
APP=${ROOST_APP:-/volume1/docker/ai-coding-web/app}
if curl -sf -m 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  exit 0
fi
# 残留 backend 会占 8787 导致新实例自杀，先清（daemon 不占 8787，不动它）
pkill -f "stati[c]-server.mjs" 2>/dev/null
pkill -f "tsx/dist/.*src/index" 2>/dev/null
pkill -f "backend/src/index" 2>/dev/null
sleep 2
nohup "$APP/deploy/nas-run.sh" >/dev/null 2>&1 &
