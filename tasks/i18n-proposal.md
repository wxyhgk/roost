# 待决策（2026-09-08）
# - 状态：已调研，未开工。用户指示「先放一放」。
# - A 是否要英文界面？决定了走到第几步。当前判断：短期不需要，但文案集中本身有独立价值。
# - B 命名风格：t.session.kill 这种嵌套对象，还是扁平 key（session.kill）？铺开前需先对齐。
# - C 后端错误码：要不要现在就 code 化，还是等真需要翻译时再按需补。当前建议后者。

# 前端国际化处理方案（v1，待拍板）

不引任何 i18n 库，先解决「文案散落」，再决定要不要解决「多语言」。两件事可以分开做，
且第一步的调用点形状和第二步一致，所以第一步不是白干。

## 现状审计（2026-09-08 实测）

全前端约 **318 条中文字面量**，分布在 30 个文件。密度前十：

| 条数 | 文件 |
|---|---|
| 49 | `components/FilesView.tsx` |
| 47 | `library/client.ts` |
| 40 | `components/NotesView.tsx` |
| 35 | `components/settings/CliSettings.tsx` |
| 24 | `molecule/MoleculeModal.tsx` |
| 23 | `components/TerminalDiagnostics.tsx` |
| 18 | `components/SessionRow.tsx` |
| 16 | `components/HistoryViewer.tsx` |
| 13 | `terminal/imagePaste.ts` |
| 13 | `store.ts` |

按处理难度分四类：

1. **UI 静态文案** —— 按钮、标题、菜单项、空状态。最多，也最规整，机械替换即可。
2. **带插值的运行时消息** —— 如 `已交给终端连接：${title}`（`NotesView.tsx`）、
   `无法打开 ${req.path}：路径不在当前工作目录内…`（`FilesView.tsx`）。需要参数化。
3. **`window.confirm` / `window.alert` 文案** —— 散在 FilesView、ProjectGroup、TermView、
   LibraryRecovery。这批本来就该换成内联 `NoticeBar`（会抢焦点，且与界面其余部分风格不一致），
   建议和文案抽取合并做。
4. **后端来的消息** —— 前端只是转发，不在翻译层控制范围内。见下节。

### 一个约束

`library/client.ts` 有 47 条，是密度第二高的文件，但它被 `scripts/check-boundaries.mjs`
强制**不许 import React**（规则：state core must remain independent of React）。
所以翻译层必须能以纯函数方式访问，不能只提供 `useT()` hook。

## 分步方案

### 第一步：集中文案（不依赖后端，随时可做）

新建 `frontend/src/strings.ts`，纯对象 + 函数，零依赖：

```ts
export const t = {
  session: { kill: "结束会话", quietFor: (label: string) => `静默 ${label}` },
  files: { readDirFailed: "读取目录失败" },
} as const;
```

这一步**不解决国际化**，解决的是现在就在痛的问题：

- 同一概念多种说法（「会话」/「终端」混用）无法审阅；
- 改文案要全仓 grep；
- code review 里看不到「这次改动动了哪些用户可见文字」。

因为是普通模块导出，`library/client.ts` 也能用，绕开 React 约束。

### 第二步：加语言（真要英文时再做）

把 `t` 换成 `zh` / `en` 两份 + 一个极简 `useT()`。第一步已经把调用点定型，
这一步基本不碰组件。

### 第三步：上框架（大概率永远不需要）

只有真出现复数规则、日期本地化、RTL 时才考虑 `i18next`。
以本产品形态（本机单用户开发工具）判断，用不上。

## 需要后端配合的部分

**结论：现在不用动。** 前端第一步不依赖后端；后端来的消息只影响错误提示这一小块。
等真要英文时，也只需 code 化前端翻译表里实际用得上的那些，不必一次铺全。

真要做时，三件事：

1. **错误响应加稳定的 `code`。** `backend/src/library.ts` 已经是对的形状
   （`{error:{code,message}}`，有 `invalid_request` / `too_large` / `storage_unavailable`
   / `internal_error` / `method_not_allowed`），其他端点照抄。
   `message` 降级为兜底与日志。**code 一旦发布即为 API 契约，改名会破坏前端翻译表。**
   缺 code 的端点：`backend/src/cli-configs.ts`（`{error:{message}}`）、
   `backend/src/server.ts:326`（`{message}`）。

2. **英文纯文本出口归口。** `backend/src/server.ts` 有一批 `text(res, 4xx, message)`
   直接把 Node 的 `err.message` 或英文字面量（如 `path escapes workspace`）送出，
   前端原样显示。应改走 code 化的 JSON 出口。

3. 前端 `frontend/src/api/request.ts` 已在 2026-09-08 做过一轮兜底中文化
   （网络不可达 / 超时 / 无响应体的 HTTP 错误），后端自己返回的 message 仍原样透传。

## 附带发现的 bug（与 i18n 无关，可独立修）

**文件保存失败时用户会看到裸 JSON。**

`backend/src/server.ts:326` 对 `FileWriteError` 返回 `{"message":"..."}`（JSON），
而 `frontend/src/api/files.ts:58` 走 `await res.text()` 后直接把整个响应体当消息抛出。
于是非 409 的写入失败，界面上显示的是字面量 `{"message":"文件已被其他程序修改"}`。

409 走的是另一条分支（`res.json()` 后取 `body.message`），所以只有非 409 受影响。

两边任选一边修，建议前端解析 JSON 并把形状统一到 `{error:{code,message}}`，
顺带为第一条后端改动铺路。
