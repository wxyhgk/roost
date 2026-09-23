import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "@roost/i18n";
import { IconChevron } from "../../../shared/icons";
import { getTerminalHandle, sendToSession } from "../public";
import {
  HOLD_MS, KEY_ROWS, LATCHES_OFF, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS,
  consumeLatches, encodeBarKey, encodeChar, holdLatch, latchActive, latchMods, tapLatch,
  type BarKey, type Latch, type Latches,
} from "../keys";

/**
 * 手机上的终端按键栏。
 *
 * **为什么要自己做**：xterm.js 的维护者原话是 "This is out of scope for this library"，
 * code-server 以 not planned 关了单，ttyd 的社区 PR 排了半年没合。没有人会替我们做，
 * 而软键盘上打不出 Esc——在手机上连退出一个 AI CLI 都退不出来。
 *
 * 键位、序列、修饰键状态机在 `../keys.ts`（纯 .ts，能测）；这里只剩「按下去」和「画出来」。
 */

const OPEN_KEY = "roost-keybar-open-v1";

function readOpen(): boolean {
  // 默认展开：第一次在手机上打开的人不知道有这么一栏，藏起来等于没有。
  try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; }
}

function rememberOpen(open: boolean) {
  try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); }
  catch { /* Storage unavailable: the current view still honours the toggle. */ }
}

/**
 * 粗指针设备吗。
 *
 * 判据和 `index.css` 里 `.touch-only` / `.icon-button` 用的是**同一条** `(pointer: coarse)`。
 * 这里却要用 JS 问一遍，而不是挂那个类：键栏占掉屏幕底部一条，右下角那一列浮动按钮
 * （跳到底部、选择文本）必须让开同样高度——CSS 能把自己藏掉，没法告诉 React 让开多少。
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}

export function useKeyBar(sessionId: string) {
  const visible = useCoarsePointer();
  const [open, setOpen] = useState(readOpen);
  const [latches, setLatches] = useState<Latches>(LATCHES_OFF);
  /** 键栏实际占掉的高度，给 TermView 把浮动按钮那一列顶上去用。栏没挂上时是 0。 */
  const [height, setHeight] = useState(0);

  // 换会话就把修饰键放下：举着的 Ctrl 说的是「我下一个键要怎么解释」，
  // 跨到另一个终端去必然指向错的那一下。
  useEffect(() => { setLatches(LATCHES_OFF); }, [sessionId]);

  const send = useCallback((data: string) => {
    /*
      走 `sendToSession`，和「把选区粘到 CLI」是同一条路。

      **代价要说清楚**：终端自己敲进去的字节走的是 `inputRelay`，那条路上挂着打断守卫
      （运行中的第一下 Ctrl+C 先清空输入框、第二下才真打断）。键栏这条路绕过了它，
      所以用键栏按出来的 Ctrl+C 是直接打断。往 relay 上开一个公开入口要动
      handles/sessionController，那是别人的地盘，留给后面一起改。
    */
    if (sendToSession(sessionId, data) === "rejected") return;
    setLatches(consumeLatches);
  }, [sessionId]);

  const toggle = useCallback(() => {
    setOpen(prev => { rememberOpen(!prev); return !prev; });
  }, []);

  const onHeight = useCallback((value: number) => setHeight(value), []);

  /*
    修饰键举着的时候，**软键盘上打的下一个字符要由我们来编码**，不能让它原样进 xterm。

    两个监听器不是重复：真键盘按 a 走 keydown（`ev.key` 就是 "a"），而 Android 的软键盘
    多数情况下 keydown 只给 keyCode 229 / key "Unidentified"，真正的字符要到 beforeinput
    才看得到。两条路各盖一半，谁先命中谁 preventDefault——keydown 被拦下时 beforeinput
    根本不会发生，不会重复送。

    **只在有修饰键举着的时候才挂**。没举着就一个监听器都没有，正常打字这条路上完全没有
    我们的代码——这是整段拦截唯一能让人放心的理由。
  */
  const intercepting = latchActive(latches.ctrl) || latchActive(latches.alt);
  useEffect(() => {
    if (!intercepting) return;
    const mods = latchMods(latches);
    // 只管打进这个终端的键。句柄会随重挂换新的，所以每次事件里现问，不缓存。
    const mine = (target: EventTarget | null) => getTerminalHandle(sessionId)?.isInputTarget(target) ?? false;
    const onKeyDown = (event: KeyboardEvent) => {
      // 真键盘自己按着修饰键（有人插了外接键盘）：那一下归 xterm，别叠两层。
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      if (!mine(event.target)) return;
      const data = encodeChar(event.key, mods);
      if (!data) return;
      event.preventDefault();
      // xterm 的 keydown 挂在它自己的 textarea 上；window 的捕获相位早于目标相位，
      // 这一句能让它压根看不到这个事件。
      event.stopImmediatePropagation();
      send(data);
    };
    const onBeforeInput = (event: InputEvent) => {
      // 只认「插入一个字符」。组字中的 insertCompositionText 不碰——那是输入法的中间态，
      // 拦下来会把整段候选毁掉，而 Ctrl+中文本来也没有意义。
      if (event.inputType !== "insertText" || !event.data) return;
      if (!mine(event.target)) return;
      const data = encodeChar(event.data, mods);
      if (!data) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send(data);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [intercepting, latches, sessionId, send]);

  return { visible, open, toggle, latches, setLatches, send, height, onHeight };
}

export type KeyBarState = ReturnType<typeof useKeyBar>;

function latchClass(latch: Latch): string {
  // 一次性 = 高亮，锁定 = 反白。不用 accent：`--color-accent` 在深色主题下就是白色，
  // 和「反白」撞成同一个样子，两态就看不出区别了。
  if (latch === "locked") return "border-bar-text bg-bar-text text-bar";
  if (latch === "once") return "border-bar-text/50 bg-bar-text/25 text-bar-text";
  return "border-bar-text/10 bg-bar-text/5 text-bar-text";
}

export function KeyBar({ state }: { state: KeyBarState }) {
  const { open, toggle, latches, setLatches, send, onHeight } = state;
  const root = useRef<HTMLDivElement>(null);
  /** 这一次按下的现场：长按已经触发过了吗、连发的两个计时器。 */
  const press = useRef<{ held: boolean; hold?: number; delay?: number; repeat?: number }>({ held: false });

  // 量自己的实际高度报给 TermView。算出来的高度会骗人：安全区（刘海/手势条）
  // 的 env() 只有浏览器知道，行数又会随折叠变。
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => onHeight(element.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); onHeight(0); };
  }, [onHeight]);

  const stop = useCallback(() => {
    const current = press.current;
    if (current.hold !== undefined) window.clearTimeout(current.hold);
    if (current.delay !== undefined) window.clearTimeout(current.delay);
    if (current.repeat !== undefined) window.clearInterval(current.repeat);
    press.current = { held: false };
  }, []);

  useEffect(() => stop, [stop]);

  const down = useCallback((key: BarKey) => {
    stop();
    if (key.modifier) {
      const name = key.modifier;
      press.current.hold = window.setTimeout(() => {
        press.current.held = true;
        setLatches(prev => ({ ...prev, [name]: holdLatch(prev[name]) }));
      }, HOLD_MS);
      return;
    }
    const data = encodeBarKey(key.id, latchMods(latches));
    if (!data) return;
    send(data);
    if (!key.repeats) return;
    /*
      连发重复的是**按下那一刻算出来的那串字节**，包括当时举着的修饰键。按住不放是一个
      手势、一个键，中途换解释只会让人莫名其妙；何况那时候一次性的修饰键已经落下了。
    */
    press.current.delay = window.setTimeout(() => {
      press.current.repeat = window.setInterval(() => send(data), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }, [latches, send, setLatches, stop]);

  const up = useCallback((key: BarKey) => {
    // 长按已经把它锁上/解锁了，抬手不能再翻一次。
    if (key.modifier && !press.current.held) {
      const name = key.modifier;
      setLatches(prev => ({ ...prev, [name]: tapLatch(prev[name]) }));
    }
    stop();
  }, [setLatches, stop]);

  const label = (key: BarKey) => {
    const name = t.terminal.keyBar.keys[key.id];
    if (!key.modifier) return name;
    const latch = latches[key.modifier];
    return latch === "off" ? name
      : `${name}（${latch === "locked" ? t.terminal.keyBar.locked : t.terminal.keyBar.once}）`;
  };

  return (
    /*
      固定在可见视口底部，和触屏选区那条工具条同一个理由（见 TouchSelection.tsx）：
      软键盘和地址栏会让任何跟随定位频繁失准。两条栏**互斥显示**，由 TermView 决定——
      进了选区模式每一次轻点都在圈范围，这时候方向键既用不上也点不着。
    */
    <div
      ref={root}
      role="group"
      aria-label={t.terminal.keyBar.label}
      style={{ WebkitTouchCallout: "none" }}
      className="fixed inset-x-0 bottom-0 z-30 select-none border-t border-bar-text/10 bg-bar pb-[env(safe-area-inset-bottom)] shadow-pop"
    >
      {/* 折叠开关做成一条通栏的把手：底部这点空间要和软键盘、状态栏抢，键栏必须收得起来。
          它只有 28px 高，但横跨整屏——够不着是宽高共同决定的，这一条比任何 44×44 都好点。 */}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t.terminal.keyBar.collapse : t.terminal.keyBar.expand}
        title={open ? t.terminal.keyBar.collapse : t.terminal.keyBar.expand}
        className="flex h-7 w-full items-center justify-center text-bar-dim"
        onPointerDown={event => event.preventDefault()}
        onClick={toggle}
      >
        <span className={`inline-flex ${open ? "rotate-90" : "-rotate-90"}`}><IconChevron open={false} /></span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-1 pb-1">
          {KEY_ROWS.map((row, index) => (
            <div key={index} className="grid grid-cols-7 gap-1">
              {row.map(key => (
                <button
                  key={key.id}
                  type="button"
                  aria-label={label(key)}
                  aria-pressed={key.modifier ? latchActive(latches[key.modifier]) : undefined}
                  title={key.modifier ? t.terminal.keyBar.modifierHint : undefined}
                  /* 44px：手指点不准更小的东西，`.icon-button` 在粗指针下也是这个下限。
                     Esc 再加一档字重——三家原生终端都把它排在最高优先级，它是这栏存在的理由。 */
                  className={`min-h-11 touch-manipulation rounded-md border text-caption ${
                    key.id === "esc" ? "font-semibold" : ""
                  } ${key.modifier ? latchClass(latches[key.modifier]) : latchClass("off")}`}
                  /* preventDefault 是必须的：按钮一拿到焦点，xterm 的输入框就失焦，
                     软键盘当场收起来——每按一次方向键收一次，这栏就没法用了。 */
                  onPointerDown={event => { event.preventDefault(); down(key); }}
                  onPointerUp={() => up(key)}
                  onPointerCancel={stop}
                  onPointerLeave={stop}
                  onContextMenu={event => event.preventDefault()}
                >
                  {key.face}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
