# 独立终端工作台交付与故障验收

日期：2026-09-07。

## 已交付

- 独立源码入口 `stable-workbench/src/main.ts`，独立 HTML/CSS、v2 transport、esbuild 构建及 Node 静态服务。
- 固定版本 `1.0.0`，buildId `0a3fa64bbea2aa38`。
- 安装目录 `/Users/you/.diy-ai-coding-web/workbench/releases/1.0.0-0a3fa64bbea2aa38/`，当前指针已在候选验收后启用。
- 正式页面 `http://127.0.0.1:8789`，浏览器直接连接 8788 的稳定基座；无 8787 或 Vite 代理，无 CDN。
- 会话列表、切换、输入输出、状态与重连已实现；每个终端保持挂载。开发区预留为独立区域，首版不嵌业务 iframe。
- `scripts/start-core.mjs` 给既有额外 Origin 增补 localhost/127.0.0.1:8789；已安装 core 运行时通过相同环境配置允许新页面。

## 版本隔离

候选产物先校验 hash、复制到开发目录之外，再从空 cwd 独立验证。默认安装不切换 current；测试明确检查候选安装保留旧指针，只有 --activate 改变 current/previous。所有浏览器资源均来自版本目录。正常开发不会更新已安装产物。

本次没有覆盖旧 release 内容，也没有重新构建/替换正在使用的 core.mjs；只为旧 core 版本 `45fc7ad659773e1f` 增加 Origin 启动配置。

## 协议验收

6 项独立测试全部通过：

1. ready 使用 protocol 2、instanceId，不夹带 resize/snapshot；replay 应用前不发送输入。
2. 旧连接正在解析的输出完成后，新的 hello 使用对应已应用游标；catchup 保序。
3. 缺口强制完整 replay，新实例不复用旧游标。
4. 页面刷新从完整 replay 开始；销毁释放解析等待，旧连接不能放开输入。
5. 独立客户端连接真实测试 PTY、断线重连与模拟刷新，PID/instanceId 不变。
6. 候选安装从空 cwd 运行，不覆盖 current；显式启用保存 previous；重复安装不覆盖文件。

当前完整 `npm run verify`：230 项测试、全部 workspace 类型检查、前端构建与边界检查通过。开发前端仍有原有大 chunk 提示；独立工作台构建单独通过依赖边界校验。

## 浏览器故障验收（隔离资源）

使用已安装候选静态服务 8790 → 独立 core 8791、临时 daemon 与真实 PTY；未停止用户正在开发的 Vite/业务后端。

- 启动测试用真实 Vite 5199，然后停止其 PID 2151。
- 使用真实业务后端入口，指定临时数据目录与已占用端口 8791；业务后端以 EADDRINUSE 启动失败。
- 独立页面仍可输入命令并显示 `STABLE_AFTER_FAILURE`。
- 刷新页面后恢复历史标记、重新显示已连接；原终端 PID 2043、instanceId `ad2a9dfb-7041-4e8d-8a5d-c665ae4fdfeb` 不变。
- 新增第二个隔离 PTY，输入 `SECOND_TERMINAL_OK`，切回原终端仍保留输出；DOM 确认两个 terminal-host 同时挂载。
- 打开开发区占位，终端保留并可继续使用。因首版不加载业务 iframe，本次不宣称已验收真实 iframe 编译错误 UI。

## 正式基座核对

为允许新 Origin，仅重启 8788 网关，保持同一已安装 core 版本。重启前后：

- daemon owner PID 始终为 13671。
- 原有终端 PID 15347、16083、16439 及其 instanceId 全部不变。
- 带 Origin `http://127.0.0.1:8789` 的 health 请求由 403 变为允许。
- 正式页面列出全部 3 个原终端并连接成功；采用被动接入，没有向用户终端发送测试输入或主动 resize。

测试用静态服务/core/daemon/Vite 及临时脚本已清理；正式 8788/8789 服务保留运行。开机自启不在首版范围。未创建 Git commit。

## 1.0.1 外观调整

安装并启用 `1.0.1-fa02f69e607cc459`，旧版 `1.0.0-0a3fa64bbea2aa38` 保留在 previous。仅重启静态服务 8789，未重启 core 或用户 daemon。

- 采用中性深灰配色、紧凑工具栏、细分隔线和低饱和选中状态；路径、PID、构建信息降低视觉权重。
- 侧栏增加会话搜索，匹配目录、CLI 和 PID。筛选不卸载终端，也不切换当前会话。
- 开发区增加独立关闭按钮，默认收起，保留终端挂载。
- 类型检查、6 项工作台测试、工作区边界检查和 diff 空白检查通过。
- 在隔离的真实 PTY 上完成浏览器截图检查、搜索与清除筛选、开发区开关和命令输入输出验证，显示 `WORKBENCH_VISUAL_OK` 后才启用候选。隔离服务与临时脚本已清理。
