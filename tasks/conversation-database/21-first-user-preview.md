# 对话列表：第一条用户消息预览

`GET /api/conversations` 的每个 `items[]` 新增必有字段：

```ts
firstUserMessagePreview: string | null
```

示例：两个标题都叫“前端”的对话，可以分别在标题下显示“调整侧边栏宽度”和“修复文件保存报错”。标题本身不改变。

## 字段规则

- 只取已保存的 user 消息文本，跳过 assistant、tool 和空白正文；没有可用用户文本时为 null。
- 合并换行、制表符等空白，去掉首尾空白，截取最多 120 个 Unicode 码点。不切断 UTF-16 代理对，不额外添加省略号；不是按复杂 emoji 组合的字素计数。
- 同一事件有多个保存版本时使用最新版本的文字，保持它第一次保存的位置和时间。
- 候选用户消息都有有效时间戳时按时间升序、原始入库序号次序选第一条；时间戳不完整时整条对话回退到入库顺序，不猜缺失时间。补收更早且有时间依据的记录后，预览可随下一次列表请求更新。
- 数据来自 SQLite 已保存的有界消息预览。它不宣称是完整原生记录的绝对第一句，也不会为填这个字段读取原生日志或启动 CLI。

只给当前分页的对话批量查询一次预览。列表页和预览在同一个数据库快照内读取；不新增数据库表或迁移。默认 created 和 activity 两种排序、搜索及 project/terminal/state 筛选都返回此字段，不改变既有游标规则。

## 前端接法

列表项类型增加该字段，在标题下面按普通文本显示；null 时隐藏。兼容仍运行旧版 HTTP 的情形，可先按 `item.firstUserMessagePreview ?? null` 处理。不要当 HTML 渲染，不需要逐条请求消息接口。

字段属于 `ConversationListItem`，不增加到详情/PATCH 响应的 `ConversationRecord`，也不作为用户可编辑的标题保存。已在 workspace-store 公共类型出口导出。

本轮没有修改前端、重启 HTTP 或 daemon；部署此字段只需更新 HTTP 进程，daemon 不需要升级。

## 验证

新增存储专项 4 项和真实 HTTP 专项 1 项；覆盖空正文、角色筛选、空白归一、中文/emoji、旧记录补收、消息修订、跨 CLI 隔离、分页/筛选、终端删除后保留。

`npm run verify` 退出 0：workspace-store 98 通过；backend 217 通过、7 跳过；全部工作区类型检查、测试、前端构建和源码边界检查通过。日志 `/tmp/conversation-preview-verify.log`。测试使用隔离 SQLite 和合成消息，没有读取用户原生日志，也没有进行前端视觉或日常服务验收。
