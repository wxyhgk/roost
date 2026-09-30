/**
 * 写入剪贴板，返回是否成功。
 *
 * navigator.clipboard 只在安全上下文（HTTPS 或 localhost）下存在。经 http 端口映射
 * 访问时它是 undefined，直接调用会抛 TypeError。这里保留 execCommand 退路——它虽然
 * 已废弃，但在非安全上下文下仍然可用，而写入剪贴板本身没有别的办法。
 *
 * 返回布尔而不是抛错：所有调用点关心的都只是「成没成」，各自给自己的提示。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒、或文档此刻没有焦点，都回落到下面的退路。
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // 必须真的在文档里且可选中，同时不能滚动视口、不能被看见。
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  // 复制会清掉用户当前的选区（比如终端里刚划的那段），用完还回去。
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

/*
  **写不进去就先扣住，等下一次点击补上。**

  终端里的程序可以用 OSC 52 让终端替它写剪贴板——Claude 的新 TUI 选中即复制走的就是
  这条路。问题是这份写入**不在任何用户手势里**（字节从 WebSocket 异步到达），而我们跑在
  http 非安全源上：

  - `navigator.clipboard` 在非安全上下文里**不存在**，xterm 自带的 provider 直接调它，
    当场抛 TypeError，于是那次复制无声地丢掉——TUI 那边显示「已复制」，系统剪贴板里
    什么都没有，粘到别的程序里是空的。
  - `document.execCommand('copy')` 这条退路在非手势下**也不行**：实测返回 false
    （同一段代码放进点击回调里返回 true，且读回来确实是那段文字）。

  所以只能把文字扣在这里，并让界面给出一个可点的入口：那一下点击就是缺的手势。
  **不自动在下一次任意点击时偷偷补写**——用户点的是别的东西，剪贴板被悄悄改掉
  比没复制更糟。
*/
let pending: string | null = null;
const pendingListeners = new Set<() => void>();

function announce() { for (const fn of [...pendingListeners]) fn(); }

/** 此刻有没有一段「复制失败、正等着补写」的文字。 */
export function pendingClipboardText(): string | null { return pending; }

export function subscribePendingClipboard(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

export function clearPendingClipboard() {
  if (pending === null) return;
  pending = null; announce();
}

/** 写剪贴板；写不进去就扣住，交给界面去要那一次点击。 */
export async function writeClipboardOrHold(text: string): Promise<boolean> {
  if (!text) return true;
  if (await writeClipboard(text)) { clearPendingClipboard(); return true; }
  pending = text; announce();
  return false;
}

/**
 * 补写扣住的那段。**必须在用户手势里同步调用**——`writeClipboard` 在没有
 * `navigator.clipboard` 时会直接走 execCommand，中间不 await，手势才留得住。
 */
export async function flushPendingClipboard(): Promise<boolean> {
  const text = pending;
  if (text === null) return true;
  const ok = await writeClipboard(text);
  if (ok) clearPendingClipboard();
  return ok;
}
