import { getTerminalHandle } from "./public";

/**
 * 把某个终端当前的可见文本存成 .log 下载。
 *
 * **只收一个显示名，不收会话对象**：文件名怎么起是调用方的事，终端这层不该知道
 * 「会话标题」这种上层概念。
 */
export function downloadTerminalLog(sessionId: string, name: string) {
  const text = getTerminalHandle(sessionId)?.serializeText() ?? "";
  // 文件名里不能出现路径分隔符和 Windows 保留字符，否则下载会被浏览器拒掉。
  const safe = name.replace(/[/\\:*?"<>|]/g, "-").slice(0, 80) || "terminal";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safe}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让某些浏览器还没读完就断掉，给它一点时间再回收。
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
