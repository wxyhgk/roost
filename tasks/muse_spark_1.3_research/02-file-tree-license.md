# 02 文件树：源码借鉴、当前能力与许可边界

核查日期：2026-09-09。Warp 本地 HEAD 为 `1f0cf55afb29c71d94f2980b384aa11cb3cdb85a`；我方以 HEAD `dde67009d412b60c18f3d8c58d57fbdf645939a1` 加当前未提交工作区为准。下述路径均相对本仓根目录；Warp 路径省略前缀 `research/third-party/warp/`。行号是本次快照定位，后续以符号名查找。

结论：可以借鉴 Warp 的交互规则和增量更新设计，也可以在适用许可条件下复用代码。当前最有价值的是补齐文件树缓存失效、键盘导航和排序；我方已经有监听、懒加载及文件编辑，不需要从头搬一棵 Rust 文件树。

## 1. Warp 源码确实实现了什么

| 能力 | 实现证据 | 对我方的意义 |
| --- | --- | --- |
| 文件树 UI 与键盘操作 | `app/src/code/file_tree/view.rs:94` 的 `FileTreeAction`；`:2940` 的 `impl View for FileTreeView`；`:3008` 起处理上下选择、展开、折叠、执行 | 可整理为浏览器文件树的行为需求，不能把 WarpUI 视图直接塞入 React |
| 目录优先、数字自然排序、组内点文件优先 | `app/src/code/file_tree/view/editing.rs:27` 的 `sort_entries_for_file_tree` | 可独立定义我方排序规则；点文件是否显示是另一项产品选择 |
| 低成本共享树与父子索引 | `crates/repo_metadata/src/file_tree_store.rs:13` 的 `FileTreeEntry` 使用 `Arc`，修改走 `Arc::make_mut`；`file_tree_store/file_tree_state.rs:12` 的 `FileTreeMapStore` 有 `parent_to_child_map` | 这是内存数据结构，不是要求我方引入 Rust、Merkle 或新数据库 |
| 加载状态与忽略状态 | `crates/repo_metadata/src/file_tree_update.rs:67` 的 `DirectoryNodeMetadata` 含 `loaded`、`ignored`；`file_tree_store.rs:50` 的 `load_at_path` | “尚未加载”与“空目录”应分开；`ignored` 不能简单等同“名字以点开头” |
| 远端增量补丁 | `crates/repo_metadata/src/file_tree_update.rs:28` 的 `RepoMetadataUpdate`、`:49` 的 `FileTreeEntryUpdate`；`file_tree_store.rs:203` 的 `apply_repo_metadata_update` | 先处理 `remove_entries`，再应用 `update_entries`；`:219` 的 `apply_entry_update` 补入/更新节点，并非看到 `parent_path_to_replace` 就删除整棵旧子树 |
| 文件树交互测试源码 | `crates/integration/src/test/file_tree.rs:32/85/129/186/228/265` | 六个测试覆盖内置编辑器打开、新 pane、新 tab、键盘导航、不可打开文件、嵌套文件；只有一项专门是键盘导航 |

这些是实现和测试定义，不是 spec 中的愿望，也不代表本次运行通过了 Warp 测试。测试用例可以帮助提取验收场景，但复制其源码同样需要遵守许可。

## 2. 我方已有能力及实际缺口

| 当前能力 | 我方源码证据 | 剩余边界 |
| --- | --- | --- |
| 文件系统直接列目录 | `backend/src/fs.ts:30` 的 `listDir` | 已目录优先，使用普通 `localeCompare`，没有显式数字自然排序；过滤固定名单及所有点文件，没有 `.gitignore` 语义 |
| 文件监听与合并 | `backend/src/watcher.ts:31` 的 `createFileWatcher`，`:54` 的 `watchRoot` | 每根共享递归 `fs.watch`，默认 150ms 合并，仅发整树失效信号；不是路径级补丁。计时器在首事件启动，不是每个事件重置 |
| 监听断线恢复 | `frontend/src/api/fileWatch.ts:20` 的 `watchFiles`；`FilesView.tsx:614/622` 接入 `rev` | 连续失败达到 10 次通知 UI，手动刷新可重启监听，重新连上会补一次失效；不能再列为“无监听” |
| 子目录懒加载 | `frontend/src/components/FilesView.tsx:1031` 的节点 `toggle`，`:1041` 首次 `listDir` | 首次请求没有独立请求代次保护；`:1055` 的已展开目录刷新 effect 仅依赖 `[rev]`，关闭目录跳过刷新，已有缓存再展开不一定重新获取。需验证慢请求与关闭期间失效场景 |
| 根列表及预览异步保护 | `frontend/src/components/FilesView.tsx:904` 的目录读取 effect、`:924` 的预览 effect | 二者已有 `cancelled` 保护，不能笼统写成“所有读取均无防竞态” |
| 文件预览、编辑、改名、删除 | `frontend/src/components/FilesView.tsx:125` 的 `FilePreviewModal`、`:1073` 起的节点操作；`backend/src/fs.ts:156` 起保存冲突处理 | 树导航优化应保留已有未保存确认、冲突处理与插件预览 |
| 工作区存储 | `packages/workspace-store/src/store.ts:13` 起的存储组合，`:22` 的 `loadWorkspace` | SQLite 存项目、会话、偏好等；文件树节点来自 `listDir` 并由 React 保存，不能描述为“SQLite 文件树” |

推荐的实现顺序：

1. 先补关闭目录缓存失效和首次异步展开的请求有效性。验收慢请求期间切换位置、目录关闭期间增删文件再展开、监听重连后的列表恢复；保留已有根列表和预览防竞态。
2. 增加文件树键盘焦点与上下/左右/Enter 行为，再调整数字排序。明确隐藏文件开关、`.gitignore` 是否影响显示，避免混为一个 `ignored` 标志。
3. 用大目录实测请求数与渲染时间。只有整树失效引发的请求或渲染成为瓶颈时，再引入目录级失效/补丁；协议必须明确删除、重命名、版本或重同步规则，不能只抄一个字段形状。

## 3. 许可应如何表述

本地 `README.md:52` 起声明 `warpui` 和 `warpui_core` 为 MIT，其余代码为 AGPL v3。`Cargo.toml:27` 指定 `AGPL-3.0-only`，`app/Cargo.toml:10` 与 `crates/repo_metadata/Cargo.toml:8` 继承它；两个 UI crate 的 `Cargo.toml:7` 分别声明 MIT。因此，上述文件树应用和存储代码不在 MIT 范围内。

- **AGPL 不等于禁止复用。** 复制、修改、分发时需要遵守适用条件；第 5 条处理修改作品的传递，第 6 条处理非源码形式的传递，第 13 条要求支持远程网络交互的修改版本向相关用户提供该版本对应源码的获取机会。不能概括成“任何使用都必须公开整个 Git 仓库”。[GNU AGPL v3 原文](https://www.gnu.org/licenses/agpl.en.html)
- **本地 HTTP 不足以判断整个应用属于同一受许可作品。** FSF 对组合程序的解释同时考察通信机制和通信语义；端口、同仓存放、是否调用 REST，都不能单独决定边界。直接把 AGPL 实现翻译、嵌入产品与两个独立程序通信也不是同一种情况。[GNU FAQ：组合程序边界](https://www.gnu.org/licenses/gpl-faq.html.en#MereAggregation)
- **`private: true` 不是闭源许可证。** 我方 `package.json:3` 和根目录未发现 LICENSE 的事实，不足以推导用户已选择闭源或 AGPL。本文不代替项目的许可决策，也不要求为研究源码先改变整个项目许可证。
- **换语言不免除许可，也不阻止技术移植。** Rust 算法可以重写为 TypeScript，但 WarpUI 的生命周期、数据共享和事件系统需要适配；逐句翻译不能因语言不同就视为无关实现。
- **读过源码后重写，不应自动称为 clean-room。** 本次是源码对照调研，没有建立隔离设计与实施流程。可按独立的产品行为需求实现通用能力，但不能仅凭“重写思想”保证任何具体实现都不涉及受保护表达。
- **MIT 部分可按 MIT 条件复用。** 本地 `LICENSE-MIT:1` 起要求在副本或实质部分中保留版权与许可声明；提取代码时还要核对其依赖和其他文件许可，不能认为来自 MIT crate 的片段可以连同 AGPL 应用层依赖一起无条件搬运。

本轮只修订说明，没有复制第三方实现到产品。若后续决定直接移植文件树源码，再按具体文件、依赖、组合方式及分发/远程使用方式确定适用义务；当前改进可先按上述独立需求推进。
