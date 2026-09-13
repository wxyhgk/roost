# 内容工作空间：开源项目调研

调研日期：2026-09-07。

目标：沿用可道云的“文件管理 + 应用打开方式”思想，让用户在工作台创建分子、流程图、图片和笔记，保存后直接提供给 AI，减少手动复制、下载与再次上传。

本轮核对官方仓库、开发接口、许可及部分发布记录；未部署候选产品、未执行嵌入原型，也未进行完整源码审计。下文的适配成本和实施顺序是基于这些材料的设计判断。默认分支和在线文档可能领先于稳定发行版，落地时需固定版本复核。

## 结论

保留当前工作台，建立内容类型与编辑器注册机制。完整产品用于参考架构，成熟编辑器作为接入候选。终端独立保持挂载，各编辑器按需加载；单个编辑器失败应局限在自己的区域。

优先参考：

- Puter：文件如何交给应用、应用如何启动与通信。
- AFFiNE：同一份内容如何在文档和画布中组织、呈现。
- LibreChat：文件上下文、生成结果与 AI 对话如何关联。
- Ketcher、Excalidraw、draw.io：直接评估嵌入与内容往返。
- React Flow、Fabric.js：需要定制工作流或图片标注时采用的基础库。

## 候选项目

| 项目 | 官方能力与接入依据 | 我们可借鉴或复用的部分 | 适配判断与边界 |
|---|---|---|---|
| [Puter](https://github.com/HeyPuter/puter) | 自托管 Web 桌面与应用平台；启动 API 可接收文件路径和文件对象 | 应用注册、文件打开方式、窗口与应用实例生命周期 | 优先读机制；整体替换会引入另一套文件、用户与运行环境。仓库默认 AGPL-3.0，另有例外及第三方许可 |
| [AFFiNE](https://github.com/toeverything/AFFiNE) | 文档、白板与表格组合；BlockSuite 编辑器；本地优先与协同 | 多种内容的共同模型、视图与数据分离 | 不必把整个工作台做成无限画布。集成其编辑器需要评估数据模型、包边界和构建体积 |
| [LibreChat](https://github.com/danny-avila/LibreChat) | Agents、MCP、文件上下文、Artifacts | 对话与文件引用、生成内容展示、上下文反馈 | 适合参考 AI 交互，不等于能直接替代终端 CLI 的接入层；仓库 MIT |
| [Ketcher](https://github.com/epam/ketcher) | 可嵌入分子编辑器，结构导入导出及图像生成 API | 新建分子、结构编辑、生成预览 | 优先候选；主项目 Apache-2.0，保留 NOTICE 并核对依赖。Standalone 与远端服务模式的具体能力需实测 |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | React 白板组件，场景数据与图片导出 | 白板、草图、简单图示和标注 | 接入已有 React 工作台较直接；MIT。嵌入组件后仍需自己实现保存、附件和恢复，并非自动拥有官网全部服务 |
| [draw.io](https://github.com/jgraph/drawio) | 完整图表编辑器，iframe 消息协议 | 流程图、架构图、图表素材库、XML 与预览导出 | 优先评估协议接入。代码 Apache-2.0；图标、模板等资源存在单独条款。公开嵌入服务和自托管构建需分别验证 |
| [React Flow](https://github.com/xyflow/xyflow) | 可定制节点与连线；节点、边、视口保存恢复示例 | 具有业务语义的工作流编辑器 | MIT；它提供图编辑能力，任务执行、依赖调度、重试等需我们实现 |
| [Fabric.js](https://github.com/fabricjs/fabric.js) | 对象变换、画笔、图像滤镜及 JSON/SVG/PNG 等输入输出 | 自定义图片标注与合成 | MIT；属于画布基础库，需要自己做工具栏、撤销、资源管理和保存体验 |

## 近期状态：本轮可确认的发布证据

- [Puter 发布页](https://github.com/HeyPuter/puter/releases)：页面标记最新版本为 26.08.2，发布日期显示为 8 月 24 日。
- [Ketcher 发布页](https://github.com/epam/ketcher/releases)：3.18.0，2026-09-02；包含嵌入场景修复与浏览器内 Indigo 模块更新。
- [LibreChat 发布页](https://github.com/danny-avila/LibreChat/releases)：顶部为 2026-09-03 发布的 v0.8.8-rc2，明确是预发布版本；包含全屏 Artifacts、Mermaid 导出、原始文件下载等改进。
- [Excalidraw 发布页](https://github.com/excalidraw/excalidraw/releases)：页面标记最新版本为 v0.18.1，为 0.18.x 的安全补丁。不能拿官网功能或主分支能力直接推定已发布 npm 包的能力。

其他候选本轮确认了当前官方仓库与接口文档，但没有逐一完成发布周期和维护响应审计；不按星数或仓库年龄判断可用性。

## 具体可借鉴的接入机制

### 1. 文件交给应用，而不是编辑器自行寻找文件

[Puter 的 launchApp 文档](https://docs.puter.com/UI/launchApp/)支持应用名称、参数、file_paths 和 FSItem 等输入。

我们的设计可借鉴为：用户选择内容后，由宿主按类型找到编辑器，传入文件引用及权限。编辑器不直接依赖终端 store，也不自行猜测当前项目目录。

### 2. 编辑器返回源数据，宿主负责保存

[draw.io 嵌入协议](https://www.drawio.com/docs/reference/embed-mode/)提供初始化、load、save、autosave、export 等消息。宿主可以接收 XML，再请求图像导出。官方在线嵌入入口是 embed.diagrams.net；本地固定版本、自托管部署的兼容性需要单独验证。

我们可以采用类似的明确生命周期：打开 → 加载指定版本 → 编辑变化 → 请求保存 → 宿主返回新版本 → 更新预览。

iframe 和 React 组件使用同一份宿主能力合同。前者通过校验来源和窗口身份的消息协议调用；后者通过传入的接口调用。

### 3. 源数据与预览同时保留

[Ketcher API](https://github.com/epam/ketcher)提供结构读取与 generateImage；[Excalidraw 导出接口](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export)提供图像导出；[React Flow 保存示例](https://reactflow.dev/examples/interaction/save-and-restore)保留节点、连线和视口。

建议根据类型保存：

| 类型 | 可继续编辑的源数据 | 供人及多模态 AI 查看 |
|---|---|---|
| 分子 | 编辑器原生结构，按需导出 MOL/SDF/SMILES | PNG/SVG 结构图及结构摘要 |
| 流程图 | draw.io XML 或我们定义的节点图 JSON | PNG/SVG，以及节点和连线摘要 |
| 白板 | 场景 JSON 和引用的图像附件 | PNG/SVG，以及文字摘要 |
| 图片标注 | 原图与标注对象 | 合成图或指定选区 |
| 笔记 | Notes 服务中的正文与版本 | 正文或选中段落 |

预览绑定源数据的同一版本；生成失败不能把旧预览标记成最新。SMILES 等交换表示不应无条件替代编辑器原生格式，以免损失排版或更丰富的结构信息。

### 4. AI 上下文是单独一层

[LibreChat Agents 文档](https://www.librechat.ai/docs/features/agents)将文件上下文、工具和 Artifacts 作为明确能力。

我们需要补齐自己的“交给 AI”流程：先保存指定版本，再交付源文件、摘要和适合目标模型的预览；记录交付给哪个会话、哪个版本。浏览器展示完成不代表 CLI 或远端工具已经读到了内容。

初步引用模型可包含 resourceId、provider、revision、source、preview 和 summary。它只是设计草案，不是现有接口。

本地 CLI 可通过受控路径读取；远端工具需要可访问的文件传输或授权读取方式。MCP 可以成为访问入口，但仅安装 MCP 不会自动解决浏览器附件、服务器文件和 CLI 工作目录之间的位置差异。

## 许可核对重点

- [AFFiNE 根 LICENSE](https://github.com/toeverything/AFFiNE/blob/canary/LICENSE)将 packages/backend 和 packages/common/native 指向另外的许可；其他部分适用 MIT，第三方部分保留其原许可。不能依据 README 的社区版描述，把整个仓库当作统一 MIT。
- [draw.io README](https://github.com/jgraph/drawio)区分源代码与图标、模板、图形库条款；素材对特定生态的使用有限制，代码许可不能替代素材条款。
- Puter 仓库默认 AGPL-3.0；借鉴交互思想与直接复制代码是不同的工作，具体复用应在固定版本上审查。

这些是选型时的许可范围记录，不构成对整个产品组合的法律结论。

## 推荐实施顺序

1. 先定义最小编辑器合同：类型、创建、打开、保存、导出预览、未保存状态和关闭。
2. 用 Ketcher 跑通“新建分子 → 编辑 → 保存 → 重开 → 交给当前 AI 会话”。验证结构与图像属于同一版本。
3. 接入 Excalidraw，验证合同能承载非化学内容与图片附件。
4. 有完整流程图需求时接入 draw.io；有可执行任务图需求时再评估 React Flow，执行引擎另行设计。
5. 有明确图片编辑需求后，用 Fabric.js 补充标注与合成；独立 Notes 通过资源引用接入，继续由 Notes 管理原始数据。

不要一开始同时安装所有大型编辑器。每个原型需验证暗浅主题、离线资源、保存失败、冲突、关闭草稿恢复，以及编辑器异常时终端仍可用。

本次只新增调研文档，没有安装候选库、替换工作台或修改 Notes 产品目录。
