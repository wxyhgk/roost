// 终端路径插入工具：文件树拖放/右键插入共用。
// 调用方本来就从 terminal 拿 sendToSession，这里归位，navigate.ts 只剩面板跳转总线。

// 文件树拖进终端的 DataTransfer 标记；另带一份 text/plain 方便外部粘贴。
export const ROOST_PATH_MIME = "application/x-diy-session-path";

// shell 双引号引用：空格引号 $ ` ! 等才包起来，包起来后转义 " $ ` \ !。
export function quoteShellPath(p: string): string {
  if (!/[\s"'`$\\!]/.test(p)) return p;
  return `"${p.replace(/(["$`\\!])/g, "\\$1")}"`;
}
