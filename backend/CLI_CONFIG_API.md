# CLI 配置：前端联调契约

后端提供全局 SQLite 配置库，独立于会话生命周期。首轮包含自定义识别、名称和 Logo；不包含自动执行启动命令。

## 配置结构

```json
{
  "id": "chemist",
  "name": "Chemist",
  "command": "chemist --interactive",
  "rules": [{ "kind": "executable", "value": "chemist" }],
  "iconRef": null,
  "iconUrl": null,
  "builtin": false,
  "enabled": true,
  "priority": 0,
  "capabilities": { "text": true, "image": false }
}
```

`id` 是稳定字符串，不可编辑，不要用名称、启动命令或固定枚举代替。`command` 保存启动命令，CRUD 不执行命令。

## 接口

| 方法及路径 | 请求 | 响应 |
|---|---|---|
| GET `/api/cli-configs` | 无 | 200 `{ configs: [...] }`，包含已禁用项 |
| POST `/api/cli-configs` | 必填 name、command、rules；可选 id、iconRef、enabled、priority | 201 完整配置；省略 id 时服务端生成 |
| GET `/api/cli-configs/:id` | 无 | 200 完整配置 |
| PATCH `/api/cli-configs/:id` | 仅需要修改的字段，不能修改 id、builtin、capabilities | 200 完整配置 |
| DELETE `/api/cli-configs/:id` | 无 | 204；自定义项删除，内置项禁用 |
| POST `/api/cli-configs/:id/reset` | 无 | 200 内置原始配置，包括原始 Logo、识别规则、enabled=true |
| POST `/api/cli-configs/:id/icon` | **原始图片 Blob**，Content-Type 为 image/svg+xml、image/png、image/jpeg 或 image/webp；不是 FormData | 200 完整配置，含新 iconRef/iconUrl |
| GET `/api/cli-icons/:ref` | 使用返回的 iconUrl | 图片 |

上传前先创建配置。图片最大 1 MiB，接受静态 SVG/PNG/JPEG/WebP，拒绝损坏图片；限制解码像素数。PNG/JPEG/WebP 统一转为最长边 512px 的 PNG；SVG 清理后仍以 SVG 保存，保留 viewBox、路径、渐变与透明度。SVG 仅保留静态绘图元素和属性，内联 style 的常用绘图属性会转为属性；脚本、事件、外部资源、动画、foreignObject、样式表及 use 元素不会保留，DOCTYPE/实体声明直接拒绝。复杂 CSS 图标请先导出为路径和内联绘图属性。图标原子写入应用数据目录 `cli-icons/`，文件名按内容生成，客户端不能指定文件路径。相同图标可复用。旧图标暂不自动清理。

`iconRef: null` 恢复通用图标；也可指定已存在上传图标引用或 `builtin:claude|codex|grok|qwen|opencode`（实际为其中一个字符串）。`iconUrl` 是后端相对 URL，前端应加自己的 API base URL。OpenCode 暂用通用终端图标，可上传替换。

错误格式 `{ error: { message } }`。非法字段/规则 400，不存在 404，重复 id 409，过大 413，不支持图片 415，上传超时 408。接口没有 revision 条件写保护；多窗口同字段最后提交生效。

## 识别规则

规则之间为“或”。仅识别进程的可执行文件或脚本位置，不搜索 prompt 文本，不接受任意正则。

- `executable`: 文件名，如 `chemist`；不含路径、空白。
- `script`: Node/Bun/Python 脚本的完整路径或路径后缀，如 `chemist/main.py`。
- `executablePathContains`: 可执行文件路径片段，例如 `/.local/share/claude/versions/`。

每条配置 1–32 个规则。priority 为 -1000..1000 整数，同一进程有多个匹配时高优先级先选；相同优先级自定义项优先，再按 id 排序。enabled=false 不参与识别。内置默认项为 Claude Code、Codex、Grok、Qwen Code、OpenCode。

## 前端接入

1. 设置页加载配置列表，实现新建、编辑、删除/禁用、恢复默认。
2. 文件选择器 accept 增加 `.svg,image/svg+xml`，上传 SVG 原始 Blob 并设置 `Content-Type: image/svg+xml`；使用 `<img src={iconUrl}>` 展示，不直接注入 SVG 字符串。Logo 上传成功后用响应替换本地配置，侧边栏即时读取名称和 iconUrl。
3. `GET /api/workspace`、会话详情、`GET /api/core/sessions` 的会话，以及 WebSocket `hello` / `cli` 消息提供 `cliId: string | null`。前端使用 `cliId` 查配置，未知/已删除配置回退通用图标，不能再写死类型或直接访问 `LOGOS[id].label`。
4. 暂时保留旧 `cli` 字段供旧客户端使用，仅返回旧四种身份或 null；**包括 OpenCode 在内的新接入必须读取 cliId**。
5. 自定义 CLI 默认仅文本，不能按名称推断图片能力。内置的 image=true 表示存在现有图片插入适配器，不代表所有 CLI 版本都已验证；现有图片接口继续返回自己的能力/验证结果。
6. 保存失败保留表单并显示错误。首轮没有配置变更 WebSocket 推送；当前窗口直接应用写入响应，其他窗口聚焦时重新 GET 配置。

## 运行与验收

新版 terminal-daemon 每约 2.5 秒扫描时从 SQLite 读取配置。修改规则、禁用或添加配置，无需重启已运行的新版 daemon 或终端。

**升级前已运行的旧 daemon 不会自行加载新代码。** 首次部署需安排终端任务结束后升级 daemon；仅重启业务 HTTP 后端不足以激活旧 daemon 的新识别逻辑。实现及测试没有重启用户现有 daemon。稳定 core 的新增 cliId 字段也需在受控升级后生效。

验收：创建自定义项 → 在终端启动对应程序 → 收到 cliId → 上传图标 → 侧边栏更新；编辑/禁用规则后识别变化且原 PTY PID 不变；删除会话后配置仍保留；重开服务后名称和 Logo 仍存在。
