# 现有前端的固定版本工作台 1.1.0

页面 `http://127.0.0.1:8789`。按用户最新确认，直接编译 `frontend/src/main.tsx → App → Shell` 及现有 CSS、组件和业务功能，不再维护另一套工作台界面。`frontend/stable.html` 仅先读取本机运行配置，然后加载同一个主入口。

独立的是安装和运行：Vite 仅用于构建。静态资源、React、终端库、图标和按需加载的业务模块均安装在开发目录之外；运行不读取 checkout、node_modules、Vite 服务或 CDN。Google Fonts 链接不进入稳定入口。

## 服务关系

- 浏览器直接访问 8788 的 `/api/core/sessions` 与 `/api/core/pty`，终端不经过 8787。
- 同一个前端的 `/api/*` 业务请求由固定静态服务转发到 8787；笔记、文件、分组和会话管理仍依赖业务后端。业务失败显示在相应区域，文件/资料和快速切换各有 React 错误边界。
- 会话发现以 core 存活列表为准，业务工作区只提供可选名称/分组信息，不阻塞终端加载；稳定入口跳过旧工作区迁移。切换终端不依赖业务保存请求。
- 使用现有终端 connection/resume/controller；稳定模式发送 v2 JSON 输入，回放完整解析后才允许输入，重连复用完整显示游标。页面刷新从 core 全量回放。
- 稳定模式不发送 snapshot/appearance-response，消费自动颜色查询；尺寸通知需在选中且主动操作终端后才发送。深浅主题沿用现有设置，CLI 自身显式配色仍由 CLI 决定。

## 构建和安装

```sh
npm run workbench:build
node scripts/install-workbench.mjs
```

候选安装到 `~/.roost/workbench/releases/<version>-<buildId>/`，每个资源校验 hash。构建会记录实际模块输入并拒绝后端/daemon/数据库依赖。默认安装不切换 current，也不覆盖旧产物。测试也只重新构建 checkout 中的 dist。

先在独立测试 core 上验收候选：

```sh
WORKBENCH_PORT=8790 WORKBENCH_CORE_URL=http://127.0.0.1:8791 \
WORKBENCH_BUSINESS_URL=http://127.0.0.1:8792 \
node ~/.roost/workbench/releases/<version>-<buildId>/server.mjs
```

测试 core 需允许精确 Origin `http://127.0.0.1:8790`。业务地址可以指向未监听的测试端口，验证业务离线时仍可连接终端。不要停止真实 daemon。

验收后运行 `node scripts/install-workbench.mjs --activate`，仅重启 8789 的静态服务，或用 `npm run workbench:start` 启动所选版本。独立运行使用安装器打印的绝对路径命令。`previous` 保留上一个版本；切换软链接不会改变已运行的服务。没有配置开机自启。

环境变量：`WORKBENCH_HOST`（默认 127.0.0.1）、`WORKBENCH_PORT`（8789）、`WORKBENCH_CORE_URL`（http://127.0.0.1:8788）、`WORKBENCH_BUSINESS_URL`（http://127.0.0.1:8787）。安装/启动支持 `WORKBENCH_INSTALL_DIR`。

## 验证

`npm test --workspace frontend` 覆盖现有前端和 core 协议适配。`npm test --workspace @roost/stable-workbench` 覆盖原型传输回归、现有前端连接器接真实 core/PTY 的重连和刷新、完整前端构建与候选安装隔离。`src/transport.ts` 仅保留为旧传输合同测试夹具，不进入产品构建。

固定版本不等于消除所有前端错误：业务区域的渲染错误可局部恢复，共享 Shell 或浏览器进程本身出错仍可能需要刷新；daemon 退出仍会结束其 PTY。业务后端在线时才能创建、结束、重启会话及使用资料/文件 API。
