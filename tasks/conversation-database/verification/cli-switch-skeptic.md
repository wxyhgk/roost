# 同 PTY 跨 CLI 换绑：独立复核

日期：2026-09-09。结论：**本次后端修复限定通过，无剩余阻塞**。仅只读源码、隔离合成数据和真实 HTTP/WS 测试；未调用模型、重启日常服务或操作前端。

根因确认：journal 顶层没有 cliId，但完整保留 agent.agent；原自动消费忽略归属，且用旧 binding CLI 限制 pump，OpenCode→omp 无法前进。修后从旧 cursor 之后读取连续稳定 journal，要求明确新 CLI 归属与可建立身份的事件，异步前后复核 runtime/instance/generation/revision，再 rebind 新 cliId/native ID。旧历史保留，旧订阅关闭；明确旧 CLI 事件只推进 cursor，不污染新身份或正文。

独立发现并复测的缺陷：

- **S1 混合无标签事件**：明确 omp/new 后跟无 agent 的旧 stop，原修订会二次 rebind 成 omp/old 并展示旧正文。独立 `/tmp/ai-switch-skeptic.mjs` 首次复现 rebound=2；新增持久 `sourceRequiresCli` 后同反例为 omp/new、rebound=1、无旧正文。该标志随 rebind 保留，并由 SQLite record_json 恢复。
- **S2 手动候选覆盖**：默认 legacy 兼容原可让无标签旧记录推翻明确候选。现在 scanner 一旦见明确归属就拒绝无标签候选；手动跨 CLI/严格源也显式要求归属。纯旧版无标签 journal 的兼容行为不冒充跨 CLI 证明。
- **S3 未知事件二次换绑**：scanner 跳过未知 event，但原 projection 在事件识别前 adopt nativeId。独立 `/tmp/ai-switch-unknown-skeptic.mjs` 首次复现 rebound=2；共用 `canEstablishAgentIdentity` 后同反例保持 omp/new、rebound=1。未知事件不能改变身份/path；session_end 仅结束当前匹配身份，不新建 generation。

本人重新运行 `ai-identity.test.ts` 与 `ai-cli-switch.test.ts`：**19 passed，0 failed**。其中包含同页/后续页无标签污染、source 重建、从 SQLite 重建 bridge、未知事件、gap/runtime drift，以及实际 WS 旧流关闭后新 generation 重连、旧历史仍可读。两个独立临时反例也复测通过。

限制：CLI 运行状态与 journal 是有序但非原子观察；agent 标签不等于进程级来源证明。同终端以后返回同一种 CLI 的更复杂迟到 hook 场景，不因这次 OpenCode→omp 修复就宣称全部解决。当前测试原生 CLI 事件为合成，未把无模型测试写成真实 CLI 切换实测。
