// 终端路径插入工具：文件树拖放/右键插入共用。
// 调用方本来就从 terminal 拿 sendToSession，这里归位，navigate.ts 只剩面板跳转总线。

// 文件树拖进终端的 DataTransfer 标记；另带一份 text/plain 方便外部粘贴。
export const ROOST_PATH_MIME = "application/x-diy-session-path";

/*
  引用本身搬去了 `shared/shell.ts`，这里只做转发。

  原因是它原来是**这个文件独有的一份黑名单实现**，而 `features/bookmarks/model.ts` 另有
  一份单引号的、正确的实现——两份各自演化，弱的那份漏了 `( ) ; & |` 等一批元字符。
  同一个问题不该有两个答案，尤其当其中一个答案会让文件名里的 `;` 真的执行起来。
*/
export { quoteShellPath } from "../../shared/shell";
