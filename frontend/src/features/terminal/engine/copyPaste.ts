import type { Terminal } from '@xterm/xterm';
import { isMac } from './keys';
import { writeClipboard } from '../../../shared/clipboard';

/**
 * 一次按键的裁决。
 * - `copy`：复制选区、清选区、吞掉这一下（于是下一次 Ctrl+C 就是中断）。
 * - `swallow`：既不给浏览器也不给终端。
 * - `pass`：原样交给终端（Ctrl+C 就是 SIGINT）。
 * - `native-paste`：交还浏览器的原生 paste。
 */
export type CopyPasteVerdict = 'copy' | 'swallow' | 'pass' | 'native-paste';

/**
 * Windows / Linux 上的复制粘贴裁决。**纯判断，不碰终端也不碰剪贴板**，所以能单独测。
 *
 * 这两个平台上 Ctrl+C / Ctrl+V 身兼两职：既是系统的复制粘贴，又是终端的
 * 中断（0x03）和字面量转义（0x16）。xterm 默认一律当终端键处理并 preventDefault，
 * 于是浏览器根本没机会复制或粘贴。macOS 没有这个问题——那里复制粘贴走 ⌘，
 * 和终端的 Ctrl 天然分开，所以整段只对非 Mac 生效（见 attachCopyPaste）。
 *
 * 裁决规则和 GNOME Terminal / Windows Terminal 一致：
 * - 有**非空白**选区时 Ctrl+C 复制并清掉选区，于是下一次按就是中断，两个意图都留得住。
 *   （agent 在跑的话，那一次还会先被 interruptGuard 换成「清空输入」，见它的说明。）
 * - 没有选区、或者选区全是空白时，原样放行成 SIGINT。
 * - Ctrl+V 交还给浏览器原生粘贴，而不是自己去读剪贴板：
 *   navigator.clipboard 在非 https 下不存在，读不到；原生 paste 事件则一直可用，
 *   xterm 自己就监听着它（CoreBrowserTerminal 在 textarea 与 element 上都注册了）。
 *   `native-paste` 那条路上**不能** preventDefault，原生粘贴才会照常发生。
 */
export function copyPasteVerdict(
  ev: Pick<KeyboardEvent, 'type' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>,
  selection: string,
): CopyPasteVerdict {
  if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return 'pass';
  if (ev.code === 'KeyC') {
    /*
      **只有非空白的选区才算「有东西可复制」。**

      在空白处手滑拖出三五个像素，xterm 就会给出一段全是空格的选区。原来那一行拿它
      当真值，于是走复制分支：preventDefault、清选区、**不发 SIGINT**——用户看到的是
      「按了 Ctrl+C 完全没反应」，而且重现不了，因为那次手滑没人记得。
    */
    if (selection.trim()) return 'copy';
    // Ctrl+Shift+C 在 Chrome 里是「检查元素」。没有选区时原来直接漏给浏览器，于是
    // 反射性地连按两下就把 DevTools 开出来盖住整个界面。挡掉，但也不送进终端。
    return ev.shiftKey ? 'swallow' : 'pass';
  }
  if (ev.code === 'KeyV') return 'native-paste';
  return 'pass';
}

export function attachCopyPaste(term: Terminal) {
  if (isMac()) return;
  term.attachCustomKeyEventHandler(ev => {
    // getSelection 要走一遍缓冲区，只在真可能用到的那一下才问：普通打字的 c 也是 code KeyC。
    const selection = ev.ctrlKey && ev.code === 'KeyC' ? term.getSelection() : '';
    switch (copyPasteVerdict(ev, selection)) {
      case 'copy':
        ev.preventDefault();
        void writeClipboard(selection);
        term.clearSelection();
        return false;
      case 'swallow':
        ev.preventDefault();
        return false;
      // 返回 false 且不 preventDefault：xterm 直接返回，原生 paste 事件照常到达。
      case 'native-paste':
        return false;
      default:
        return true;
    }
  });
}
