# 前端解耦第二轮：状态订阅与依赖约束

日期：2026-09-07。承接 [第一轮](20260907-frontend-decoupling-implementation.md)。

## 工作区状态

- 将纯 reducer / 数据定义提取到 `frontend/src/store/state.ts`；同步状态源与字段选择器位于 `store/observable.ts`。
- WorkspaceProvider 保留启动、轮询、持久化、服务端动作协调；Context 提供稳定状态源和动作对象。
- `useWorkspace` 必须显式列出订阅字段。全部现有消费者（包括 quietNotify）完成迁移；类型约束禁止空参数调用。
- 字段未变化时选择器保持快照引用。项目展开、错误等变化不再通过全量 Context 值迫使只依赖 sessions/selectedId 的订阅者更新。
- 依赖当前状态的动作从同步状态源读取，避免连续操作在 React 下一次渲染前读到旧值。
- 这不等同于组件绝不重渲染：普通父子渲染和消费字段的实际变化仍然会触发渲染；未宣称具体性能提升比例。

## 资料订阅

- 移除 LibraryClient 全局编辑 version / emit 公共入口，替换为单记录、各资料类型待保存成员、恢复面板三类通知。
- 当前编辑器订阅自身记录；未保存列表只对成员变化更新，列表内每一行独立订阅相应草稿。
- LibraryRecovery 使用独立订阅与 memo，NotesView 提供稳定 onOpen 回调。
- 恢复备份缓存扫描结果。当前窗口每次输入仍按原策略持久化草稿，但不会重复扫描整个存储来渲染恢复列表。
- 资料库身份初始化、备份移除、恢复操作、跨窗口 storage 事件使恢复列表失效；备份写入失败/恢复正常时仍通知错误状态。storage.clear 的空 key 也被处理。

## 可执行依赖约束

在 `scripts/check-boundaries.mjs` 增加少量规则，纳入已有 verify：

- library 不得反向依赖 components、workspace、terminal 等外部前端模块。
- library 的 client/query/api 与 workspace state/observable 不得依赖 React。
- workspace 纯状态不得依赖具体功能模块。
- terminal/public 不得直接引入渲染引擎或 useTerminal。

这些是针对现有边界的直接 import 检查，不是完整传递依赖或运行时耦合检测。

## 验证结果

- `npm run verify` 成功退出：213 项测试（frontend 63 项）、各 workspace 类型检查、前端构建、依赖边界检查全部通过。
- `git diff --check` 通过。
- 新增测试覆盖：工作区不相关字段变更保持选择快照稳定；连续同步动作读取最新状态；会话实时字段更新可见；编辑单条记录 100 次不通知其他记录/类型、不重扫备份；外部备份变化和移除仍刷新恢复结果。
- 使用隔离数据库、独立后端/前端端口做浏览器回归：新建笔记与自动保存；编辑后新建分组，正文和保存状态保留；新建终端后会话更新并显示已连接；页面捕获 error 日志为空。
- 构建仍有大 chunk 提示，本轮没有做首屏性能测量。
- 临时测试服务与目录已清理；本轮没有重启正式终端 daemon，没有提交 commit。

## 后续范围

终端完整会话生命周期控制器、文件链接来源 sessionId、导航多查看器语义、更多预览按需加载仍属于后续独立工作。工作区乐观写失败的全量 hydrate 回滚策略本轮保留。
