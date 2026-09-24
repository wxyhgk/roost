import { getTerminalHandle } from "./public";
import { downloadFile } from "../../shared/download";

/**
 * 把某个终端当前的可见文本存成 .log 下载。
 *
 * **只收一个显示名，不收会话对象**：文件名怎么起是调用方的事，终端这层不该知道
 * 「会话标题」这种上层概念。
 */
export function downloadTerminalLog(sessionId: string, name: string) {
  const text = getTerminalHandle(sessionId)?.serializeText() ?? "";
  // 时间戳里的 `:` 和 `.` 先换掉：它们既是文件名非法字符，也是这里唯一需要的那点格式。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadFile(new Blob([text], { type: "text/plain;charset=utf-8" }), `${name}-${stamp}.log`, `terminal-${stamp}.log`);
}
