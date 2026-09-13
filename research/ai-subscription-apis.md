# AI coding 订阅与额度接口调研

核实日期：2026-09-12。范围是工作台底部的 Claude、ChatGPT/Codex、OpenCode Go 订阅入口。本文区分官方文档、上游源码和本地验证；尚未使用用户的 AI 账号凭据查询真实额度，也没有调用模型、安装第三方采集程序或修改 CLI 登录配置。

## 结论

建议在自己的后端实现薄适配层，以官方数据入口为主，参考 CodexBar 和 Orca 的解析与缓存设计。现阶段三个平台都有可行入口：OpenCode Go 的 HTTP usage 接口、Codex App Server RPC、Claude Code statusLine JSON。优先接入用户正在使用的 OpenCode Go，再接 Codex、Claude。

底部继续保留一个可切换的 AI 槽位。账户额度、当前会话的 token、按 API 价格估算的费用应分别建模；本地日志不能代表同一个账号在其他设备上的消耗。

| 平台 | 推荐入口 | 可取得的数据 | 主要限制 |
|---|---|---|---|
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 滚动、每周、每月使用百分比与重置时间 | 需要属于有效 Go 订阅的 API Key；真实账号返回仍待联调 |
| ChatGPT / Codex | `codex app-server` 的 `account/read`、`account/rateLimits/read` | 登录状态、套餐、多种额度窗口、重置时间；部分账户有 credits | 必须保留额度范围，不能把 Codex 窗口标成整个 ChatGPT 的通用剩余额度 |
| Claude | Claude Code `statusLine` 输入的 `rate_limits` | 5 小时和每周使用百分比、重置时间 | 依赖 CLI 版本、套餐和首次 API 响应；CLI 不活跃时数据可能过期 |

## OpenCode Go：已有可直接调用的额度接口

上游 [`usage.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) 定义了 GET 路由，用 `Authorization: Bearer …` 检查 Key 所属的用户、工作区及有效订阅。鉴权失败为 401，无 Go 订阅为 403。返回 `usage.rolling`、`usage.weekly`、`usage.monthly`；各窗口包含 `status`、`percent`、ISO 格式的 `resetsAt`。这段源码没有返回续费日期或 Zen 余额；部署路径还可能经过上游代理，最终以真实响应的能力为准。

百分比已经是 0–100 的单位，`1` 表示 1%，不能再乘 100。CodexBar 的 [OpenCode 适配说明](https://github.com/steipete/CodexBar/blob/main/docs/opencode.md) 也明确了这一点，并已把 API 窗口与本地 SQLite 费用统计分开处理。

本次对公开地址只发出了**无凭据 GET**，得到 HTTP 401 和 `Missing API key.`，验证了路由部署与鉴权响应；它不能证明用户的 Key、订阅资格和成功数据结构。后续联调只需读取 usage，不需要为了测试发起模型请求。

[Go 官方文档](https://opencode.ai/docs/go/) 中的模型调用入口、支持模型、限额说明与额度查询是不同内容。不要把某个示例中的美元上限、月天数或模型清单写死；展示服务端返回的窗口与重置时间。

## Codex：优先使用官方 App Server

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#auth-endpoints) 描述了账号 RPC：

- `account/read`：识别当前登录方式与套餐，初次读取可用 `refreshToken: false`。
- `account/rateLimits/read`：读取额度；`account/rateLimits/updated` 是更新通知。
- `rateLimitsByLimitId`：按额度 ID 区分多个桶；旧客户端可能只有 `rateLimits`。
- 窗口字段包括 `usedPercent`、`windowDurationMins`、`resetsAt`，最后一项为 epoch 秒；字段可能为空。
- `account/usage/read` 是 token 活动汇总，不能直接替代限额查询。

本机 `codex-cli 0.154.0` 已通过 `app-server generate-json-schema` 导出协议，确认两个 read 方法、额度多桶及相关字段存在。这只是 CLI 协议能力验证，没有启动账号查询或登录流程。接入时按方法与响应字段检测能力，不通过硬编码版本号分支。

推荐后端以 stdio JSON-RPC 连接一个有超时和输出上限的 helper；完成初始化后读取账户，再按账户范围读取额度。复用 CLI 管理的认证流程。收到账号切换时先清除旧账号缓存；API Key 登录不能自动当作 ChatGPT 订阅登录。无需向公网另开 App Server 端口。

## Claude：新版 statusLine 已提供额度字段

[Claude 官方 statusLine 文档](https://code.claude.com/docs/en/statusline#rate-limit-usage) 列出 `rate_limits.five_hour` 和 `rate_limits.seven_day`，每项含 `used_percentage` 和 epoch 秒 `resets_at`。文档要求 v2.1.251+，适用于 Claude.ai Pro/Max，首次 API 响应后才会出现；应用网关的 spend limit 是另一种范围。

本机 Claude Code 为 `2.1.269`，符合文档的版本条件，但用户套餐及是否已经有额度数据没有验证。实现仍应检测字段是否存在。`context_window.used_percentage` 表示上下文占用，`cost.total_cost_usd` 是会话费用估算，均不应当成套餐消耗比例。

推荐提供可选的 statusLine 包装器：将允许的额度字段和采样时间交给本机采集器，同时把原始 stdin 转发给用户已有的 statusLine 命令并保留其 stdout。必须保留已有配置，避免每次状态刷新启动网络查询。不活跃时保留最后读数并明确更新时间；不要为了刷新额度自动让 Claude 发起推理。

Orca 的 `claude-oauth-usage-request.ts` 另有私有 OAuth usage 请求，包含 beta header 和硬编码客户端标识。本轮不把它作为默认接入路径。

## 可复用项目

| 项目 | 已核实能力 | 本项目的使用方式 |
|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) | MIT；支持三个目标平台；有 macOS/Linux CLI | 最完整的采集参考；若需要快速验证统一输出，可在隔离环境评估 CLI |
| [Orca](https://github.com/stablyai/orca) | MIT；已有 TypeScript 额度获取、解析、缓存模块 | 与本项目语言接近，适合参考适配层；Electron 网络、Cookie 和 UI 部分不能直接搬入 Node 服务 |
| [ccusage](https://github.com/ccusage/ccusage) | 从本地 CLI 数据生成 token/费用报告，支持 JSON | 适合后续日/月消耗统计，不能用本地记录推算整个账号的权威剩余额度 |

CodexBar 的 [`usage --format json` 与 `serve`](https://github.com/steipete/CodexBar/blob/main/docs/cli.md) 已有统一输出及缓存入口，可作为另一种实现方案。但它增加一个独立二进制及配置生命周期；Linux 自动浏览器凭据导入也有限制。对于当前只接三家的 Node 后端，薄适配层更容易控制启动成本、账户范围和数据来源。

本地 Orca 研究基线：`b6e44575520796cf9c560e5e6880a03705026d0c`，目录 `research/third-party/orca`。重点源码：

- `src/main/rate-limits/codex-rpc-rate-limit-probe.ts`：初始化与额度 RPC。
- `src/main/rate-limits/claude-oauth-usage-request.ts`：私有 usage 请求。
- `src/main/rate-limits/opencode-go-usage-fetcher.ts`：Cookie、工作区查找及 Go 页面读取。
- `src/main/rate-limits/opencode-go-page-scraper.ts`：HTML 中结构片段的百分比解析。

这份 Orca 基线里的 Go 路径依赖网页函数哈希和序列化页面格式，月窗口还使用固定时长；已有官方 usage 路由后，不建议延续这种默认路径。源码阅读不代表已验证 Orca 的实时账号查询。

## 在本项目统一接口

建议新增独立订阅模块，和服务器 CPU/内存采样分开。下面是拟议契约，尚未实现：

```ts
type SubscriptionSnapshot = {
  provider: 'claude' | 'chatgpt' | 'opencode-go';
  runtimeId: string;               // 本机或 FR
  accountRef: string | null;       // 不含凭据的内部引用
  accountLabel: string | null;
  plan: string | null;
  renewalAt: string | null;        // 只取权威续费数据
  state: 'ready' | 'stale' | 'auth-required' | 'unsupported' | 'unavailable';
  source: string;
  fetchedAt: string | null;        // 成功获取时间
  observedAt: string | null;       // 数据实际采样时间，可未知
  windows: Array<{
    id: string;
    scope: string;                // Codex、模型桶、Go 用户/工作区等
    label: string;
    usedPercent: number | null;
    durationSeconds: number | null;
    resetsAt: string | null;      // 统一 ISO 时间
  }>;
};
```

实现约束：

1. 后端持有凭据与 CLI helper，前端仅获取归一化结果；缓存键至少包含平台、运行主机、账户/工作区范围。FR 上的登录与 Mac 上的登录分别识别，不能假设已同步。
2. 返回额度窗口数组，不把所有平台塞入固定的日/周/月三个字段。重置时间不等于续费日期；缺失数据保留为空，底栏显示 `—`。
3. 首版底栏显示所选平台的主要窗口剩余百分比，弹窗列出全部窗口、账户范围、采样时间；明确百分比是已用还是剩余。百分比条可限制在可视范围，原始超限值仍需保留。
4. 同一来源合并并发请求。建议选中平台可见时 60 秒刷新，其余降为 5 分钟或按需；Claude 优先接收事件。窗口隐藏时停止页面轮询；网络失败指数退避并保留旧读数，401/403 进入明确状态，不持续快速重试。
5. 设定请求超时、JSON 大小限制和 helper 生命周期。状态栏查询不得阻塞登录、PTY 或文件接口，也不读取整个会话历史。

## 接入顺序与验收

1. **OpenCode Go**：确认运行主机上的 Key 归属，读取 usage，验证百分比单位和三个窗口；处理 401/403/429、超时、空窗口、未知新增字段。
2. **Codex**：检测 App Server 能力，完成 initialize 后只读取账号与额度；验证多桶、缺失字段、API Key 模式和账户切换时缓存隔离。
3. **Claude**：提供保留原命令的可选 statusLine 采集；验证首次响应前无数据、CLI 退出后的旧数据、跨会话/账号隔离和写入原子性。
4. **UI**：继续使用当前单平台切换器。浏览器验证切换和刷新后保留、断网时旧数据提示、未知额度不显示 0%、黑白配色、小屏弹窗不越界。

本轮可确认接口与协议存在；套餐详情、付费日期、可用账号和 FR 上三个 CLI 的实际登录能力仍需接入阶段验证。

后续实现和两端实际验证记录见 [真实 AI 订阅额度接入](../tasks/server-monitor/2026-09-12-subscriptions.md)。上面的拟议契约与账号可用性结论保留为调研时的记录，当前代码契约以 `packages/subscriptions` 为准。
