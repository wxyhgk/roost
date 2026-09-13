# CLI 切换、历史收藏与刷新恢复

## 行为

- 同一 Shell 中退出 Claude 再运行 OMP：前端以终端实例、CLI、原生会话身份重新核验；旧响应作废，新绑定尚未就绪时展示只读历史。核验成功才给当前对话显示输入框。
- 当前 CLI 没有接入结构化记录时，直接显示最近保存的历史；完全没有历史时显示明确空态。不会无限显示“等待对话身份”。
- 本终端历史下拉列出 CLI、标题、时间；选中的历史只读。全局历史目录的跟随开关在详情页仍保持订阅。
- 收藏窗口从左侧书签入口打开；在对话详情收藏。支持搜索、CLI 筛选、分组、备注、手动排序、查看历史、复制恢复命令。删除分组保留收藏，取消收藏保留历史。
- 收藏按 CLI + 原生会话 ID 去重、定位历史，元数据独立存储；同一个原生 ID 在不同 CLI 中属于不同记录。原生 transcript 缺失时不能保证 CLI 恢复命令仍能继续运行。

## Orca 参考

借鉴 `research/third-party/orca/src/renderer/src/components/right-sidebar/AiVaultPanelHeader.tsx`、`AiVaultSessionDetails.tsx` 和 `AiVaultSessionActionMenuItems.tsx` 的搜索、筛选、详情和复制恢复命令流程。收藏组织使用本项目已有的 SQLite bookmarks 数据层，没有复制 Orca 的实现。

## 刷新恢复

此前恢复按新容器尺寸解析旧网格序列化内容，尤其会移动或丢失光标下面的输入框/状态行。

- 前端在恢复队列中先 reset，再设置源行列，再解析快照；同页缓存同时携带行列。
- 缓存行列与 hello 中的 PTY 行列不一致时，不请求增量恢复，重新取完整画面。
- 新 replay 可附带服务端快照自身行列；现有旧 daemon 未附带时，前端兼容使用 hello 行列。当前用户 daemon 未因本轮修改重启。
- 恢复完成之后才按原有前台权限成对调整浏览器和 PTY 尺寸，不人为抖动尺寸逼迫 CLI 重绘。

## 验证

- 收藏和身份修改：frontend 247、backend 227、workspace-store 106 测试通过；backend 7 项既有跳过。包含 Claude→OMP 独立历史及收藏跨数据库关闭/重开的测试。
- 刷新修改：frontend 251、terminal-runtime 56、terminal-protocol 17 测试通过，之后新增控制器恢复网格测试及身份测试合计 22 项通过。
- 类型检查覆盖 frontend、backend、workspace-store、terminal-runtime、terminal-protocol、terminal-daemon；边界检查通过。
- 独立浏览器数据库验证了收藏备注保存、分组创建与归类、Claude 历史正文只读显示。截图检查了三栏窗口。测试服务不会连接用户 daemon 或数据库。
- 用户实际工作台确认能显示本终端原有历史，替代等待空页。终端刷新只做有限采样，不能把合成网格测试当作所有 CLI 场景的保证。

复现浏览器收藏样例（项目根目录）：

```sh
node --import tsx frontend/tests/browser/bookmarks-server.mts
# http://127.0.0.1:5174/tests/browser/bookmarks.html
```

退出测试服务会清理临时数据库。正式服务仍是 5173 / 8787。

## 收藏窗口补充检查

用户实页为 0 条收藏，原界面没有直接添加入口，仍显示三栏空白。新增窗口内“从历史对话添加”：搜索已保存记录、按日期浏览、直接收藏或阅读后收藏，不更改全局对话选择。未选择卡片时隐藏编辑栏；空收藏使用较小窗口；筛选改变时清除旧卡片选择。

独立真实 SQLite + HTTP 浏览器验证：从空收藏进入历史列表，收藏 Claude 条目后显示“已收藏”，返回收藏出现 1 条，整页刷新后仍保留；浏览器未报错。前端类型检查、生产构建及收藏模型/并发测试通过。可以用 `BOOKMARK_FIXTURE_EMPTY=1` 启动同一测试脚本从空收藏开始验证。
