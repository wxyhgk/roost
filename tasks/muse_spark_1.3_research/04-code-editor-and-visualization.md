# 04 Warp 的代码编辑、差异审阅与可视化

2026-09-09 源码调研，基线见 [README](README.md)。三个 subagent 分别核查文件编辑、diff/review、富内容预览，主 agent 对照我方编辑与预览链路。只读调研后新增本文；没有修改产品、构建 Warp 或完成运行验收。以下 Warp 路径相对 `research/third-party/warp/`，我方路径相对项目根目录；行号是快照定位，符号优先。

结论：Warp 的文件编辑器、代码差异审阅、Markdown/图像渲染是相互连接但职责不同的模块。值得借鉴的是共享文档状态、明确的修改基线、原文与预览切换及失败回退；无需为此把我方 CodeMirror 换成自研编辑器。

## 1. 文件代码编辑：原生编辑器与共享 buffer

文件打开链路：

1. `app/src/code/file_tree/view.rs:2209` 的 `FileTreeView::open_file` 根据设置解析 `FileTarget`，发出打开事件。因此不是每次点击都固定进入内置编辑器。
2. `app/src/workspace/view/left_panel.rs:964` 转发；`app/src/workspace/view.rs:6440` 的 `open_file_with_target` 分流代码、Markdown、外部编辑器等目标，代码分支进入 `open_code`。
3. `app/src/code/view.rs:369` 的 `construct_editor_for_location` 构建 `LocalCodeEditorView::new_with_global_buffer` 与 `CodeEditorView`；`CodeView` 管理文件 tab、临时预览与保留、保存和关闭。tab 复用受功能开关和设置影响。
4. `app/src/code/global_buffer_model.rs:1167` 的 `open_local` 按路径复用存活的 buffer，`create_new_buffer` 通过 `warp_files::FileModel::open(path, true)` 加载文件并订阅变更。

编辑核心是 Rust + WarpUI，不是 Monaco/CodeMirror 包装。`crates/editor/src/content/buffer.rs:555` 的 `Buffer` 包含 SumTree 文本、anchors、UndoStack、内容/缓冲区版本和行尾模式；`app/src/code/editor/view.rs:1788` 的 `apply_edits` 将操作交给模型与 buffer。选择、布局、装饰和绘制分别位于 `app/src/code/editor/model.rs`、`view.rs`、`element.rs`。

注意区分 `app/src/editor`：其 README 描述终端 Input Box，仍有自动建议等输入交互；不能只凭目录名把它当文件编辑器，也不能直接称其已废弃。

### 保存与外部修改

- `app/src/code/local_code_editor.rs:1760` 的 `save_local` 进入 `format_and_save`。格式化取决于设置和 LSP 是否就绪；缺少服务或格式化失败仍继续保存。
- `app/src/code/global_buffer_model.rs:806` 的 `save` 本地交给 FileModel；远端先 flush 合并中的 edit batch，再发 SaveBuffer RPC。本地、远端不是完全相同的通路。
- `crates/warp_files/src/lib.rs:725` 的 `FileModel::save` 本地调用 `async_fs::write`，完成后发成功或失败事件。本段没有可见的磁盘 mtime/content CAS，也不是临时文件加 rename 的原子替换。
- FileModel 的 watcher 监听文件所在父目录，以覆盖替换文件式保存。`global_buffer_model.rs:707` 的 FileUpdated 分支在基础版本允许时同步外部变更，用户已有编辑时保留 buffer 并上报冲突。`local_code_editor.rs:1724,2329,2524` 负责版本冲突和丢弃/覆盖界面。

因此可以说“有外部修改监听、版本模型和显式冲突处理”，不能说“保存层保证不会覆盖并发外部写入”。异步格式化期间继续输入的版本处理也应运行验证，不能从静态阅读直接认定存在或不存在缺陷。

### 语言能力

- `app/src/code/editor/model.rs:291` 持有 SyntaxTreeState；`crates/syntax_tree/src/lib.rs:79,226` 按 BufferVersion 管语法树/高亮缓存，使用 Arborium 的 tree-sitter 解析。
- `app/src/code/local_code_editor.rs:940` 的 `try_connect_lsp_server` 查找或启动语言服务；`global_buffer_model.rs:1400` 管 didOpen/didChange 生命周期。
- 已定位诊断、hover、定义跳转、引用查看及保存格式化，入口见 `local_code_editor.rs`、`app/src/code/language_server_extension.rs`、`app/src/code/find_references_view.rs`。
- 高亮与语言服务是不同能力；本轮证据不足以宣称完整 IDE 自动补全，也不能宣称远端与本地功能完全等同。

## 2. 代码差异可视化：Git 状态与 AI 候选变更分开

| 能力 | Warp 实现 | 边界 |
| --- | --- | --- |
| 工作树审阅 | `app/src/code_review/diff_state/mod.rs:304` 的 DiffMode 支持 HEAD、主分支和其他分支基线，分支比较涉及 merge-base | 表示 Git 状态，不证明改动属于哪个 AI 或哪轮会话 |
| 差异渲染 | `app/src/code/inline_diff.rs:40`、`app/src/code/editor/diff.rs:94` 的 compute_unified_diff、`app/src/code/diff_viewer.rs:145` 的 hunk 导航 | 已确认 inline/unified；本轮未找到足以确认并排切换的实现 |
| hunk 操作 | `app/src/code/editor/view.rs:469` 和 `app/src/code_review/code_review_view.rs:5640` 附近连接评论、加入 AI 上下文和 revert | 不由此推导已有逐行 stage/unstage |
| 撤销 revert | `app/src/code_review/code_review_view.rs:5796` 的 maybe_undo_revert 调编辑器 undo，记录编辑器/版本，后续修改会使旧撤销提示失效 | 不把陈旧撤销应用到任意新版本 |
| AI 待应用修改 | `app/src/ai/blocklist/diff_types.rs:14` 的 DiffBase/FileDiff 保存原文与候选变更；`diff_storage.rs:51,77` 接受候选并等待保存结果 | 渲染、批准、落盘成功是不同状态；不是直接拿 git diff 当本次工具调用结果 |
| 历史只读 | `app/src/code/inline_diff.rs:40` 要求有 FileModel 才能编辑/保存/revert；恢复历史等无文件绑定场景仅供查看 | 恢复出来的 diff 不自动获得修改当前文件的能力 |
| 评论及 AI 上下文 | `app/src/code_review/comments/comment.rs` 区分本地与 GitHub 导入评论；`context.rs` 将 diff hunks 注册为附件 | 本地评论不等于已发布 GitHub；部分上下文/评论入口受 feature flag 控制 |
| 大差异降级 | `app/src/code_review/diff_size_limits.rs:14` 根据字节、单行长度及增删行数区分正常、默认折叠、不可渲染 | 可借鉴分级降级，不机械复制阈值 |

TUI 另有 `crates/warp_tui/src/tui_file_edits_view.rs:360`：异步生成每文件 diff，折叠远离 hunk 的上下文，Blocked 时展开，接受/拒绝面向整个 action。`crates/warp_tui/src/tui_review_comments.rs` 展示成功评论工具的结果。不能把它们写成与 GUI 相同的逐 hunk 审阅、编辑和评论工作台。

## 3. 富内容可视化：Markdown、Mermaid、图片和保存的输出

### Markdown 与 Mermaid

Markdown 打开经 `app/src/util/openable_file_type.rs` 的 `renders_in_warp_notebook_viewer` 分流到 `app/src/notebooks/file/mod.rs` 的 `FileNotebookView::set_content`，再调用 `RichTextEditorView::reset_with_markdown`。Raw 模式进入 CodePane，Rendered 模式使用原生富文本渲染，不是 WebView 展示网页。

Mermaid 有完整渲染接线：

1. 文件 notebook 设置默认 Mermaid 显示模式；`app/src/notebooks/editor/model.rs` 管理各块的渲染模式和位置。
2. `crates/editor/src/content/edit.rs:855` 识别 Mermaid 块，使用 `mermaid_asset_source` 调 `mermaid_to_svg::render_mermaid_to_svg`。
3. 生成 SVG bytes 后进入 `AssetCache<ImageType>`，由 `crates/editor/src/render/element/mermaid.rs` 的 RenderableMermaidDiagram 原生布局绘制。
4. 自动渲染加载中或失败可保留源代码；显式切换渲染时可以显示加载/错误框，并有 lightbox 放大入口。10秒提示是显示超时，不证明计算被取消。

AI 输出也通过 `app/src/ai/blocklist/block/view_impl/common.rs:render_mermaid_diagram_section` 接相同资产链路，并有失败回退。相关功能受 MarkdownMermaid、EditableMarkdownMermaid、BlocklistMarkdownImages 等开关影响，不能宣称所有安装版本默认开启。

根 `Cargo.toml:204` 固定了 mermaid-to-svg Git 依赖版本。本轮未读取该外部依赖源码，不列完整图表类型，也不宣称与 Mermaid.js 完全兼容。

### 图片与 SVG

`crates/editor/src/content/markdown.rs` 将图片转成 BufferBlockItem::Image；`content/edit.rs` 的 resolve_asset_source_relative_to_directory 处理 data URI、HTTP(S)、绝对或文档相对路径；`crates/editor/src/render/element/image.rs` 负责绘制。`crates/warpui_core/src/image_cache.rs` 支持 SVG 解析及若干栅格图像格式。

这证明内联图像渲染，不证明有完整的图片文件编辑器。部分文件打开路径仍使用 FileTarget::SystemGeneric。SVG 作为图像绘制，也不等同于执行网页脚本。截图产物另经 `app/src/ai/artifacts/mod.rs` 下载解析后展示 lightbox。

### Jupyter 与代码运行

`app/src/notebooks/file/mod.rs:set_content` 在 JupyterNotebookRendering 开关启用时调用 reset_with_ipynb。`crates/ipynb_parser/src/lib.rs:ipynb_to_formatted_text` 展示保存的 stream、error、PNG/JPEG 和 text/plain；跳过 HTML、LaTeX、widgets 等，不执行 cell，也不把编辑回写 notebook。

`app/src/notebooks/editor/notebook_command.rs` 的 Run in terminal 派发 RunWorkflow，是终端执行入口，不能称为 notebook kernel 或网页结果沙箱。

本轮在相关 Rust/Cargo 路径搜索 WebView、WKWebView、BrowserPane、PDF viewer 等标识，未找到内嵌 HTML 浏览器或 PDF 查看器接线。`app/src/ai/artifact_download.rs` 中 PDF/HTML MIME 映射及 artifacts 下载入口证明下载能力，不能证明内嵌预览；此处是有限检索结论，不是对整个产品所有版本的否定。

## 4. 对照我们的项目

| 项目 | 当前我方源码能力 | 借鉴方向 |
| --- | --- | --- |
| 编辑器 | `frontend/src/editor/index.ts:createEditor` 使用 CodeMirror，有历史、搜索、括号匹配、行号及 JS/TS/JSON/Python/HTML/CSS 语言扩展；`FilesView.tsx` 管模态编辑状态 | 保留 CodeMirror；若需要多文件工作流，抽出按文档身份管理的状态，再做 tab、未保存提示与视图复用 |
| 保存冲突 | `backend/src/fs.ts:writeFileAtomic` 有同文件保存串行化、mtime 检查、临时文件写入及 rename 前复查；`FilesView.tsx` 有加载最新/保留我的内容 | 保留已有机制，借鉴外部变更同步与文档版本模型；原子替换也不等于能锁住任意外部进程的整个读改写过程 |
| 静态高亮 | `frontend/src/code-highlight.ts` 用 Shiki 生成高亮 HTML，编辑态另用 CodeMirror | 静态高亮不等于语言服务；本轮在编辑/后端路径未见 LSP 生命周期接线 |
| Markdown / HTML | Markdown 有静态高亮语言映射，HTML 有编辑语言扩展；文件预览插件链未见 Markdown 渲染、Mermaid 或 HTML 运行预览 | 先做明确的原文/渲染切换；HTML 运行是另一需求，不能等同文本编辑 |
| 媒体 | `frontend/src/editor/media.tsx` 已有图片（含 SVG）和浏览器原生 PDF iframe；`frontend/src/editor/xyz.tsx` 用 3Dmol 预览 XYZ | 这些已有能力不需为对齐 Warp 重做；沿用 EditorPlugin 按文件类型接入预览 |
| 差异审阅 | 本轮在文件编辑/预览链路未见完整 Git diff 工作台；Shiki 对 patch 的高亮不是基线比较 | 可以先建设只读工作树差异，不依赖 AI CLI 结构化事件 |
| AI 修改控制 | 当前 AI 同步契约以只读事件展示为主 | 不能只加接受/撤销按钮就获得控制能力；需要 action 身份、原始版本、候选内容、授权操作和真实保存结果 |

我方工作区在持续修改，以上为本轮所读源码能力，不代表正在运行的实例已经加载所有未提交代码。文件预览/编辑限额当前为8MiB；大文件 diff 和图表解析还需各自预算，不能因文本允许打开就无上限渲染。

## 5. 适合我方的后续批次

本节只排序编辑/可视化范围，不替代03的移动端计划。

1. **Markdown 原文/预览切换。** 复用现有插件边界，明确文档相对图片路径、链接目标、未保存内容和预览同步。验收编辑未保存时切换、加载失败、切文件及大文档。
2. **Mermaid 图表。** 建立异步渲染、源代码回退、错误显示和放大；缓存键包含源码及影响渲染的设置，过期请求不得覆盖当前文件。库选型及支持语法另行验证，不复制未经核验的依赖兼容假设。
3. **只读 Git 变更面板。** 明确仓库和 HEAD/分支基线，展示文件列表、增删统计、unified diff 和 hunk 导航；二进制、删除、重命名、大差异有降级。标注“工作树变更”，不推断为“本次 AI 修改”。
4. **文档状态与多文件工作流。** 若用户需要持续编辑多个文件，再将内容、基线、dirty、保存结果与视图分离；外部修改不能静默覆盖未保存内容，切 tab 保留选择/滚动/撤销状态。
5. **后续单独立项。** LSP、可写 hunk revert、AI action diff 接受、HTML 执行预览、notebook kernel 均需要新增服务或控制契约。HTML 预览还应独立处理执行隔离及资源来源；不是把源码注入应用 DOM。

对于第3/5项，必须区分“显示差异”“用户批准”“应用成功”和“可撤销”。这比照搬原生绘制框架更能改善我们现有工作台。
