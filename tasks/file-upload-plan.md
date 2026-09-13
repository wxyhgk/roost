# 文件上传到目录树：现状与方案

日期：2026-09-09。后端已实现并验证；前端入口和进度界面待前端接入。以下现状为实现前记录，当前契约见文末。

## 现状：文件只出不进

目录树上的文件可以**拖出去**（`FilesView.tsx` 给节点设了 `ROOST_PATH_MIME` + `text/plain`，
`effectAllowed = "copy"`），但树上**没有任何 drop 目标**，后端也没有二进制写入的口子：

- `POST /api/fs` → `createPath`：只能建**空**文件或目录
- `PUT /api/file` → `writeFileAtomic`：**只写文本**，`bytes.includes(0)` 直接 415 拒绝二进制；
  上限 8 MiB，且整包 JSON 编码——现有常量 `MAX_FILE_REQUEST_BYTES = MAX_FILE_BYTES * 6`
  就是被这个膨胀撑出来的
- 附件库（`backend/src/attachments.ts`）是给 CLI 贴图用的，按会话存放，**不落到目录树**

结论：目前没有任何办法把本机的文件放进项目目录。

## 方案

### 传输：一个文件一个请求，原始 body，流式落盘

`POST /api/fs/file?root=…&path=…`，请求体直接是文件字节。

- **不用 multipart**：不必引解析器，且天然可流式
- **不走 JSON**：二进制编码后膨胀数倍，上面那个 `*6` 的常量是前车之鉴
- **必须流式**：现有的图标上传（`backend/src/cli-configs.ts:55`）把整个请求体
  `Buffer.concat` 在内存里——1 MiB 的图标没问题，50 MB 的文件不行。
  这条路要把 `req` 直接 pipe 到临时文件，再复用 `writeFileAtomic` 里那套
  「临时文件 + 原子 rename」，避免半个文件出现在树上
- **上限边流边判**，超了就中止并删临时文件；不能信 `Content-Length`（客户端说了算）
- 上限取 **64 MiB**，与现有的 `MAX_RAW_BYTES`（原始文件下发）对齐

### 冲突：默认不覆盖

临时文件用 `open(temp, "wx")`，完成后用同文件系统 `link(temp, target)` 原子发布；目标已存在返回 409（不能用普通 rename 来保证不覆盖）。前端给三个选择：覆盖 / 自动改名（`report-1.pdf`）/ 跳过。
**不静默覆盖**——这个动作没法撤销。

### 前端：两个入口，同一条路径

- 工具栏一个上传按钮（`<input type="file" multiple>`），传到当前浏览的目录
- **拖放到树上**。注意树上已有「拖出去」的逻辑，所以必须只在
  `dataTransfer.types` 含 `"Files"` 时才当上传；拖到文件节点上时落到它的父目录，并高亮落点
- 进度用 `XMLHttpRequest.upload.onprogress`（`fetch` 没有上传进度）
- 多文件**串行**上传，避免把隧道打满、也便于看出卡在哪一个

### 顺带的复用

上传落盘会触发已有的文件监听（`backend/src/watcher.ts`），树会自己刷新，
不需要手动 `setRev`。这条路已经跑通。

## 第一版不做

| 条目 | 理由 |
|---|---|
| 文件夹上传 | `webkitdirectory` / `webkitGetAsEntry` 要递归展开并重建相对路径，成本明显高一档；先看是否真有需求 |
| 断点续传 | 本地隧道，失败重传即可 |
| 服务端解压 | 与「把文件放进来」是两件事 |

## 已知环境风险

日常访问走 nps 隧道（`TUNNEL_HOST`）。大文件会慢，中间代理可能有请求体大小限制。
真撞上了那是隧道侧的配置，不是这边的代码——「单文件 + 流式 + 有进度」的形态正是为了
让这种情况一眼能看出卡在哪，而不是一次性打包后整体失败。


## 已实现后端契约

`POST /api/fs/file?root=<绝对工作目录>&path=<相对文件路径>&conflict=error`

body 直接传 `File` / `Blob` 字节，允许二进制和空文件；不包装 JSON / multipart，不发送压缩的 Content-Encoding。目标父目录必须已经存在。单文件最大 **64 MiB**（67,108,864 字节），既检查声明大小，也逐块计数。

| conflict | 行为 |
| --- | --- |
| 不传 / error | 同名返回 409，原文件不变 |
| rename | 尝试原名，再尝试 report-1.pdf 至 report-999.pdf，返回实际文件名 |
| overwrite | 显式允许替换普通文件；传输期间目标发生变化返回 409；拒绝覆盖目录和符号链接 |

成功 `201`，包括覆盖：

```json
{"name":"report-1.pdf","path":"docs/report-1.pdf","size":12345,"mtime":1751234567890,"overwritten":false}
```

失败统一 `{ "error": { "code": "...", "message": "..." } }`：

| HTTP | code | 前端处理 |
| --- | --- | --- |
| 400 | invalid_request / not_file | 路径或选项无效，提示修改 |
| 403 | path_escape / permission_denied | 路径越界或无写权限 |
| 404 | not_found | 父目录已不存在，刷新目录树 |
| 409 | conflict | 提供覆盖 / 自动改名 / 跳过；覆盖遇到并发修改也应重新询问 |
| 413 | too_large | 单文件超过 64 MiB |
| 415 | unsupported_media_type | 不支持压缩请求体 |
| 429 | upload_busy | 每个网关最多 4 个进行中的上传；前端串行，忙时稍后重试 |
| 507 | storage_unavailable | 磁盘空间或配额不足 |
| 500 | internal_error | 显示失败，允许重试 |

临时文件和最终文件位于同一文件系统。创建/自动改名通过硬链接原子发布，覆盖通过 rename 原子替换；不支持硬链接的文件系统会失败，不降级为可暴露半文件的复制。显式覆盖的修改检测是提交前校验，不承诺与任意外部写进程实现跨进程 CAS。服务端中断、超限或客户端断连都会尝试清理临时文件；进程被强制杀死可能遗留隐藏的 `.diy-upload-*.tmp`，但不暴露半截目标文件。

目录监听忽略临时文件名，在最终文件发布后按既有机制刷新；文件系统不给出事件名时仍可能触发无害的额外刷新。前端仍负责上传按钮、Files 拖放、XHR 上传进度、串行队列和冲突选择。网络失败后可以先刷新目录确认结果，避免盲目以 rename 重试产生副本。

验证：新增 `backend/tests/file-upload.test.ts`，9 项覆盖字节保真、空文件、64 MiB 边界、声明和实际流超限、断连/失败清理、并发同名与四路限流、三种冲突策略、路径逃逸、目录监听。未修改前端，未验证公网代理的上传限制。
