// The same App is compiled for development and for immutable local releases.
export const stableRuntime = (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'stable';
export const desktopRuntime = typeof document !== 'undefined'
  && document.querySelector<HTMLMetaElement>('meta[name="roost-runtime"]')?.content === 'desktop';
type Config = { coreUrl: string; version: string };
declare global { interface Window { workbenchConfig?: Config } }
/*
  **完整后端的 WebSocket 地址。**

  这一串原来在三个地方逐字抄着：session-status 的实时推送、文件监听、对话流。抄的不只是
  base URL，连后面那行 `ws:`/`wss:` 替换也一模一样。

  失效模式完全静默：再加第四个 WS/SSE 端点时忘了这个分支，stable 构建下它会去连 workbench
  自己的 origin，而 WebSocket 的连接失败是异步事件、不会抛错——界面只是「一直没有新消息」。

  **和下面的 `coreUrl` 不是一回事，别合并。** 8788 是 stable 版自己的核心 API（会话列表
  之类，一定在）；8787 是完整后端，上面这三个都是**它独有的可选推送**，stable 核心没有。
  端口不同、可用性不同、缺席时的正确行为也不同。
*/
const FULL_BACKEND_ORIGIN = 'http://127.0.0.1:8787';
export function socketUrl(path: string): URL {
  const url = new URL(path, stableRuntime ? FULL_BACKEND_ORIGIN : window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export function coreUrl(path: string) {
  return new URL(path, window.workbenchConfig?.coreUrl ?? 'http://127.0.0.1:8788').toString();
}
