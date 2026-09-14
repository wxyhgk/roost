/**
 * 终端特性对外的**唯一**入口。
 *
 * 以前这里还有一个 `index.ts`：它才是所有 JS 项目里"门面"的惯用名，实际却只有一个
 * 内部文件在用，而且给 `mountXterm` 包了一层参数原样透传的 `mountEngine`。两个入口、
 * 名字反的，新来的人打开目录第一眼看到的是错的那个。已经删掉，只留这一个。
 *
 * 规矩：**特性外部只准从这里进**；特性内部各模块直接互相 import，不必绕这里转一道。
 * 唯一的例外是 `view/` 下的 React 组件，按路径引用是组件的常规做法。
 *
 * 类型一律从 `types.ts` 再导出，不经中转模块。以前 `SendResult` 要经 `handles` 转一道、
 * `TermStatus` 要经 `connection` 转一道，于是同一个类型有两三条 import 路径，
 * `sessionController` 里就出现过两个同源类型走不同路的情况。
 */

export type { SendResult, TermStatus } from "./types";

export {
  // 句柄与输入
  getTerminalHandle, registerTerminal, subscribeTerminalHandle,
  setTerminalInput, clearTerminalInput, sendToSession,
  // 选区
  subscribeSelection,
  // 附件落点
  getAttachmentTarget, type AttachmentTarget,
} from "./handles";

export {
  getTerminalStatus, setTerminalStatus, clearTerminalStatus, subscribeTerminalStatus,
  getTerminalLatency,
} from "./status";

export { ROOST_PATH_MIME, quoteShellPath } from "./paths";
export { emitFileLink, resolveLinkTarget, subscribeFileLink, subscribeFileLinkOpen, type FileOpenRequest } from "./fileLinks";
export { uploadSessionImage } from "./imagePaste";
