# muse_spark_1.3_research 说明

本次研究对象：本地 `research/third-party/warp` 源码，对照我方 `diy_ai_coding_web` 当前工作区。

## 核验基线

- 核验日期：2026-09-09。
- Warp commit：`1f0cf55afb29c71d94f2980b384aa11cb3cdb85a`，核验开始时第三方工作树无修改；不代表上游最新版本。
- 我方 HEAD：`dde67009d412b60c18f3d8c58d57fbdf645939a1`。本次纳入已修改及未跟踪的产品源码，不能仅检出该 commit 复现全部结论。
- 本轮由四个 subagent 分别核对终端与实时链路、文件树与许可、移动端方案、Agent 与应用壳，主 agent 汇总修订。
- 证据是源码阅读；现有测试文件仅作为后续验收入口，不代表本轮运行通过。没有构建或运行 Warp，也没有完成手机真机验证。
- `specs/` 中的计划不等同于已实现能力；GUI、headless TUI、浏览器终端的实现边界分别说明。

文档结构：

- [01-warp-borrow-and-gap.md](01-warp-borrow-and-gap.md)：当前能力、实际差距、不适用机制与落地优先级。
- [02-file-tree-license.md](02-file-tree-license.md)：文件树复用的许可边界、技术成本与已有能力。
- [03-emacs-mobile-plan.md](03-emacs-mobile-plan.md)：移动端命令与选区方案、实施依赖和验收标准。
- [04-code-editor-and-visualization.md](04-code-editor-and-visualization.md)：文件代码编辑、Git/AI 差异审阅、Markdown/Mermaid/图像预览及我方落地顺序；追加由三个 subagent 分别调研。

## 使用结论

优先改善触屏操作、终端选区和命令入口；已有的文件监听、重连上限、滚轮余数累积及偏好持久化不重复建设。性能优化先定位瓶颈，AI 控制能力与现有只读同步分开立项。文件树复用应先明确许可证及组合方式；语言差异影响移植成本，不能代替许可判断。

本文不按猜测的新增行数估工期。每项实施前应再次确认工作区变化；完成标准包含对应功能测试和必要的运行验证。
