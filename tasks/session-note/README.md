# 终端会话备注：后端契约

给终端卡片保存一段短备注，跟随终端记录生命周期。原需求见 [前端交接](../session-note-handoff.md)。不使用独立 notes 知识库，也不把这段备注绑定到长期 AI 对话。

## API

```http
PATCH /api/sessions/:id
Content-Type: application/json

{"note":"维护前端布局\n等待测试结果"}
```

- `SessionRecord.note` 为必有的 `string | null`，新会话和升级前的旧会话默认 null。
- PATCH 成功返回更新后的 record；GET 单个会话及 GET `/api/workspace` 的 sessions 项也带 note。
- 缺少 note 键时保持旧值；`""`、纯空白、null 都清空为 null。去掉首尾空白，保留内部换行。
- 原始字符串最多 2000 个 UTF-16 码元（JavaScript `.length`，与 HTML maxlength 一致）。超长返回 400 `invalid_request`，不截断；非法类型也返回该错误。校验发生在标题、分组、顺序等写入之前。
- 未知会话沿用 404。备注没有单独的版本历史或 revision，多窗口编辑按最后写入生效。

前端新增编辑/保存备注动作即可，字段作普通文本显示。清空时发送 `{note:null}` 或 `{note:""}`，不要省略键；兼容尚未升级的后端时可以用 `record.note ?? null` 渲染。

## 存储与升级

新库 sessions 带可空 note TEXT；旧库在已有初始化事务内用 PRAGMA table_info 检查后 ALTER TABLE 加列，不重建表。store setter 统一执行同样的归一与长度校验。

标题修改、cwd 更新、关闭与重新打开原会话不清掉备注，旧版使用显式列名的 writer 也不会覆盖新增列。删除终端记录时备注一起删除；之后即便复用该 terminal ID，新记录仍默认 null。独立知识库与长期 AI 对话历史不受这项修改影响。

本轮不修改前端，不重启日常服务。部署时更新 HTTP 后端即可初始化新列；无需为此结束 daemon 持有的终端。

## 验证

存储专项覆盖真实升级前六列表、原数据/rowid/排序保留、重复打开、旧 writer 兼容、长度/清空及终端生命周期。独立 HTTP 测试 5/5 通过，记录见 [verification.md](verification.md)。

2026-09-10 收尾验证：workspace-store 全量 100/100 通过；backend 全量 229 项，222 通过、7 跳过、0 失败；源码包边界检查通过。命令 `npm test --workspace @roost/workspace-store --workspace backend && node scripts/check-boundaries.mjs`，日志 `/tmp/session-note-backend-final.log`。后端与 workspace-store 类型检查通过。

全项目 `npm run verify` 未通过：最新一次停在前端类型检查，`frontend/src/components/WorkspaceRow.tsx` 引用的文案字段 `groupActivity`（63、64 行）和 `newWorkspace`（120 行）当时尚未定义，日志 `/tmp/session-note-verify-final.log`。未改动前端人员正在开发的文件，不能将本轮报告为全项目验证通过。此前发现的一处旧 store 完整对象断言已补上 `note:null`，并由上述 store 全量回归确认通过。
