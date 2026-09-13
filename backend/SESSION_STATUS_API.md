# 侧边栏终端活动状态

首轮是通用 PTY 活动观测，不是 AI 生命周期识别。前端代码未包含在本次后端实现中。

## 接口

- `GET /api/session-status`：返回全部持久会话的当前状态快照。
- `WebSocket /api/session-status`：连接后立即返回快照，此后有变化时推送完整快照，最多约每 250ms 一次。没有变化时每约 15 秒重复快照作为心跳。复用现有 Host/Origin 策略，不需要打开任何 `/api/pty` 连接。
- WebSocket 只读，发送应用消息将以 1008 关闭。慢客户端积压超过 1 MiB 会断开，重连后读取新快照。

```json
{
  "type": "session-status",
  "monitorId": "gateway-monitor-uuid",
  "revision": 12,
  "quietAfterMs": 3000,
  "sessions": [{
    "id": "s_example",
    "instanceId": "terminal-instance-uuid",
    "cliId": "claude",
    "state": "active",
    "lastOutputAt": 1788798000000,
    "outputSeq": 123
  }]
}
```

| state | 语义 | 建议显示 |
|---|---|---|
| active | 最近 3 秒观测到 PTY 输出 | 活动点，提示“终端有输出” |
| quiet | 终端存在，但最近未观测到输出 | 普通图标，提示“暂无新输出” |
| exited | daemon 已连接，但该会话已无活 PTY | 已退出 |
| closed | 持久会话已关闭，优先于其他状态 | 按现有逻辑隐藏或显示已关闭 |
| unavailable | daemon 连接暂不可用 | 状态暂不可用，不能当作已退出 |

`cliId` 是开放字符串，通过 CLI 配置查询名称和 Logo。退出/不可用时可能为 null。
`lastOutputAt` 是本 HTTP 后端收到输出的 Unix 毫秒时间；`outputSeq` 与终端重放协议的输出序号相同。尚未观测到输出时二者为 null。状态接口不返回终端正文或用户输入。

## 前端接法

1. 工作区只建立一个状态 WebSocket，用会话 id 合并快照；完整快照里已不存在的项应移除。
2. 同一 monitorId 内只接受 revision 不小于当前值的快照；同 revision 的心跳只刷新连接健康时间。
3. 前端自行重连；断连或超过约 45 秒没有快照时显示“状态连接中断”，不要继续显示旧的 active。
4. “新输出未读”在浏览器本地保存已读游标 `{monitorId, instanceId, outputSeq}`。已选中但终端隐藏、页面在后台、或尚未渲染输出，不应仅凭 selectedId 自动标记已读；应使用实际呈现的终端输出游标确认。
5. instanceId 变化表示新终端，建立新基线，不比较旧实例序号。monitorId 变化表示 HTTP 后端重新开始观测，也需建立基线；第一帧不把旧输出自动判成未读。
6. 未读提示即“有新终端输出未查看”，不能标为“AI 回复完成”。

## 准确性与边界

- TUI 重绘、动画、shell 回显也算输出；AI 思考或工具执行可能无输出。因此 active 不等于正在生成，quiet 不等于完成或等待用户。
- 本版没有 waiting-for-confirmation/completed 语义。以后接入 CLI 的可靠生命周期事件时应另加 aiState/source，保持 terminal activity 的现有含义。
- HTTP 后端即使没有浏览器连接也持续订阅全部会话。HTTP 后端停机期间的输出不补算新活动；恢复时从新的 monitorId 开始，避免重放造成误闪。
- 使用现有 daemon 事件广播，不修改 daemon 实现，不需要重启 daemon。状态观测是内存数据，原生 PTY 和历史仍由 daemon 管理。
- 第一版包含关闭会话；前端按工作区显示规则过滤。轮询状态刷新每 250ms 读取一次工作区元数据，适用于当前小规模会话量，后续可改为元数据变更订阅。
