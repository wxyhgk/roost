# 单镜像全功能版：业务后端(8787) + 生产静态前端(8080)，x86_64 群晖用。
# 本机(arm64 Mac)交叉构建：docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t roost:1.0 .
FROM node:22-bookworm AS build

# node-pty 有 linux-x64 prebuild，一般命中无需编译；装工具链只做兜底。
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund
# frontend build 内含 tsc --noEmit，类型不过构建即失败
RUN npm run build --workspace frontend

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8787 \
  ROOST_DATA_DIR=/data \
  SHELL=/bin/bash \
  STATIC_PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates bash git vim curl wget unzip openssh-client python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

EXPOSE 8080
VOLUME ["/data"]
# static-server 托管 backend 子进程并反代 /api，对外只暴露 8080
CMD ["node", "deploy/static-server.mjs"]
