# 项目删除接口

`DELETE /api/projects/:id`，路径参数使用 `encodeURIComponent(id)`，无需请求体。

成功返回 `200 application/json`，响应是完整 workspace，与 `GET /api/workspace`
的结构一致。前端可用响应更新项目列表、会话列表、选中项及展开项。

行为：

- 只删除项目分组，所属会话的 `projectId` 变为 `null`，显示在“未分组”。
- 开启和隐藏的会话都保留；`closed`、名称、目录、顺序不变。
- 保留 `selectedId`，从 `expandedProjectIds` 移除被删除的项目。
- 保留终端进程、现有 WebSocket 连接和历史记录，不操作磁盘项目文件。
- 数据库操作在一个事务内完成，失败则整体回滚。

项目不存在（包括重复删除）返回 `404 text/plain`，正文 `project not found`。
前端可在此情况下重新拉取 workspace，以处理其他窗口已删除项目的情况。

推荐按钮说明：“删除分组，保留会话”。本次没有修改前端代码。

## 已删除项目与旧窗口

`POST /api/sessions` 和 `PATCH /api/sessions/:id` 的 `projectId` 只接受字符串或 `null`。
不存在的项目返回 `404 application/json`：

```json
{"code":"PROJECT_NOT_FOUND","message":"project not found"}
```

失败时不创建会话、不修改原会话或展开项；`null` 表示移到未分组。
非字符串且非 null 的值返回 400。前端遇到 `PROJECT_NOT_FOUND` 可重新拉取 workspace。
旧数据库中已有的孤儿分组引用，在后端启动时归入未分组，保留会话及历史。

关闭或删除非当前会话会保留当前 `selectedId`；只有操作当前会话时才选择剩余可用会话，
没有可用会话时设为 `null`。
