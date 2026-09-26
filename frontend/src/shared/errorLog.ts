/*
  前端自己出的错,记最近一小段,让人能说清楚「哪儿坏了」。

  **这不是功能,是让故障能被说清楚。** 2026-09-25 在 iPad 上撞到一句
  `'text/html' is not a valid JavaScript MIME type`——那句话**不说是哪个地址**,于是查了
  半小时:开服务端访问日志、翻 Vite 的 allowedHosts、怀疑缓存,最后从 6764 条请求里确认
  那个请求根本没到这台机器。而答案一直就在 iPad 的控制台里,只是那台设备上打不开控制台,
  这边也看不到。

  **要抓的关键是资源加载失败,而不只是脚本异常。** 模块/样式/图片加载失败不会冒泡到
  `window.onerror`,只会在**捕获阶段**的 `error` 事件上出现一次,而且目标身上才有那个 URL
  ——今天那句 MIME 报错正是这一类。只装 `onerror` 会漏掉它,那等于白装。

  三个来源合起来才够:
  - 捕获阶段的 `error`：资源加载失败（script / link / img / 动态 import 的 chunk）
  - `onerror`：脚本里抛出来的异常
  - `unhandledrejection`：没人接的 promise，动态 import 失败大多落在这里

  **不记内容,只记形状。** 消息、URL、行号就够定位了;终端输出、输入、请求体一律不碰——
  这份东西是要被复制粘贴到聊天窗口里的(诊断面板已经是这个用法),不能顺手把别的带出去。
*/

/** 留多少条。够看清「一串连续失败」的形状,又不至于把内存吃掉。 */
const LIMIT = 50;
/** 单条消息截断长度。坏消息往往很长,而定位只需要开头。 */
const MAX_TEXT = 300;

export type FrontendError = {
  at: number;
  kind: "resource" | "error" | "rejection";
  text: string;
  /** 资源类错误才有：加载失败的那个地址。今天那半小时缺的就是它。 */
  url?: string;
  source?: string;
};

const entries: FrontendError[] = [];
let installed = false;

const clip = (value: unknown): string => {
  const text = typeof value === "string" ? value
    : value instanceof Error ? `${value.name}: ${value.message}`
    : (() => { try { return String(value); } catch { return "(unprintable)"; } })();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
};

function push(entry: FrontendError) {
  entries.push(entry);
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
}

/** 读最近的记录，最新的在前。诊断面板和「复制」按钮用。 */
export function readErrorLog(): FrontendError[] {
  return [...entries].reverse();
}

/** 只给测试用：清空。线上没有清空的入口——记录本来就是给事后看的。 */
export function resetErrorLog() { entries.length = 0; }

/**
 * 装上监听。重复调用无害（第二次直接返回），因为入口和热更新都可能跑到它。
 */
export function installErrorLog(target: Pick<Window, "addEventListener"> = window) {
  if (installed) return;
  installed = true;

  /*
    捕获阶段（第三个参数 true）是必须的：资源加载失败的 error 事件**不冒泡**，
    挂在冒泡阶段一条都收不到。
  */
  target.addEventListener("error", (event: Event) => {
    const node = event.target as (Element & { src?: string; href?: string }) | null;
    // 有 target 且不是 window 本身 → 资源加载失败；否则是脚本异常，交给下面那条。
    if (node && node !== (target as unknown) && (node.src || node.href)) {
      push({ at: Date.now(), kind: "resource", text: `${node.tagName?.toLowerCase() ?? "?"} 加载失败`,
        url: clip(node.src || node.href) });
      return;
    }
    const error = event as ErrorEvent;
    push({ at: Date.now(), kind: "error", text: clip(error.error ?? error.message),
      source: error.filename ? `${clip(error.filename)}:${error.lineno ?? 0}` : undefined });
  }, true);

  target.addEventListener("unhandledrejection", (event: Event) => {
    push({ at: Date.now(), kind: "rejection", text: clip((event as PromiseRejectionEvent).reason) });
  });
}
