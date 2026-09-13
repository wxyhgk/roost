# Conversation 长期管理：独立反方

日期：2026-09-09。状态：**代码独立审查完成，无剩余阻塞；最终交付以主 Agent 本轮门禁为准**。

独占此报告，不改业务/测试/前端，不调用模型或操作日常服务。

## 最低冻结契约

- Conversation stable ID 标识长期资料；terminal instance、binding generation、run 均是阶段性连接。关闭或删除终端、换 CLI、重启 gateway 不应级联删除 conversation 历史。
- 历史入口以 conversation ID 查询，只读取其实际关联的 source/generation；不得用当前同名 terminal 的新 binding 代替旧链接。CLI 相同或 native ID 字符串相同，也不能跨 source/CLI 合并。
- 数据库 run.active 是持久观察，不是当前进程在线证明。在线/可继续/可发信必须结合可达 daemon、当前 instance/native identity/generation/owner；未知/断连诚实降级。
- 旧页面持有的 expectedConversationId/expectedRunId 必须继续生效。换 CLI/恢复新 run 后，旧请求不能自动绑定“最新 run”；用户选中偏好也不赋予操作权。
- selection 是独立偏好，不通过删除 terminal 清空历史，也不能把不存在/trashed ID 静默改成别的操作目标。GET 不应隐式恢复/创建模型会话。
- 分页有稳定排序与上限；历史 links/runs 不应混入消息正文或本地凭证。未提供可靠 native resume 入口时，“继续”不可偷偷另建模型会话冒充原会话。

## 必须尝试的反例

1. terminal T 先绑定 A，后绑定 B；查询 A 的 links/generations 只返回 A 的历史，当前 T 属 B 不表示 A live。
2. 销毁 T 后 A 的 record/messages/历史链接可查询；重建同 ID 的 T 不能让旧 link 指向新 instance。
3. DB 留有 active run，daemon 不可达或 owner 已替换；API 不宣称可继续/可发信。
4. selection=A，另窗口改 selection=B；旧 A 操作不读取偏好自动发给 B。
5. 两 CLI native ID 字符串碰巧相同；关联/历史必须仍按 source 与 stable conversation 区分。
6. history/page 请求与换绑并发；不得把新 generation 正文归入旧 conversation。

接口落地后补具体代码与独立证据，设计文字不作为实现完成证明。

## 已落地审查与首轮结果

已读 links/listRuns、selection、HTTP runtime/workspace 与 daemon resolver。历史 items 明确 runtimeVerified=false，run 与 generation fallback 去重且固定插入上界；terminalId 表示历史关联，可跨重建 instance 返回历史，不冒充当前归属。selection 末写胜出，同事务校验后更新双字段；trashed 隐藏但保留 meta，恢复后可重新显现，偏好不赋予发信身份。

本人运行 store links/selection：12 passed。随后运行 HTTP management + daemon runtime：10 passed，1 failed；`pid:null,dead:true` 但 instance/cli 匹配时 HTTP 返回 200，预期 409。已通知 root 补当前活进程检查，不能只用 instance/cli 和数据库 active 证明 live。其余真实隔离 socket/PTY resolver 测试通过（CLI recognition/binding 是合成前置，不调用模型）。该失败修复前暂不放行。

上述 pid:null/dead:true 来自越过 TerminalSession 类型的异常测试数据；真实类型 pid 为 number，正常 PTY 退出会移出 runtime map。因此应定性为**防御性异常数据缺口**，不声称已发现实际服务中的死 PTY 误判。root 已在 HTTP/daemon 两处加入正 safe-integer PID 检查，且 daemon trash 返回409与HTTP一致；源码复核已确认，不重复执行 root 正在运行的门禁。

当前无剩余独立审查阻塞，待本轮最终门禁结果即可限定交付长期管理/历史关联/瞬时运行定位。该定位不承诺下一次操作仍在线，不赋予发送授权，也没有实现退出后的自动 launch/resume。

主 Agent 门禁补记：`npm run verify` 退出 0；独立 QA 修复后定向 4/4 通过。详细包计数与实测边界见 [本批验收](../19-conversation-management.md#7-本批验收记录)。
