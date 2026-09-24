import type { Terminal } from "@xterm/xterm";
import type { TermTheme } from "../types";

const CSI = "\x1b[";

function rgb(color: string): number[] {
  const hex = color.replace(/^#/, "");
  if (!/^[a-f\d]{6}$/i.test(hex)) throw new Error("terminal theme requires #RRGGBB colors");
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}
function appearanceReport(theme: TermTheme) {
  const [r, g, b] = rgb(theme.background);
  return `${CSI}?997;${0.299 * r + 0.587 * g + 0.114 * b < 127.5 ? 1 : 2}n`;
}

/** Color replies have one gateway-elected owner; replay never reissues old queries. */
export function attachAppearance(term: Pick<Terminal, "parser">, initial: TermTheme, send: (data: string) => void) {
  let theme = initial;
  let subscribed = false;
  let owner = false;
  let ready = false;
  let replaying = false;
  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canReply = () => !disposed && owner && ready && !replaying;
  function reply(data: string) { if (canReply()) send(data); }
  function notify() {
    clearTimeout(timer);
    if (!dirty || !subscribed || !canReply()) return;
    timer = setTimeout(() => {
      if (!dirty || !subscribed || !canReply()) return;
      dirty = false;
      send(appearanceReport(theme));
    }, 30);
  }
  function reset() {
    subscribed = false;
    dirty = false;
    clearTimeout(timer);
  }
  const subscriptions = [
    ...([true, false] as const).map(enabled => term.parser.registerCsiHandler({ prefix: "?", final: enabled ? "h" : "l" }, params => {
      if (!params.includes(2031)) return false;
      subscribed = enabled;
      if (!enabled) { dirty = false; clearTimeout(timer); }
      // Let xterm handle other DEC modes in the same sequence.
      return params.length === 1;
    })),
    term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, params => {
      if (params.length !== 1 || params[0] !== 2031) return false;
      reply(`${CSI}?2031;${subscribed ? 1 : 2}$y`);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, params => {
      if (params.length !== 1 || params[0] !== 996) return false;
      reply(appearanceReport(theme));
      return true;
    }),
    term.parser.registerEscHandler({ final: "c" }, () => { reset(); return false; }),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => { reset(); return false; }),
  ];
  return {
    forwardColorResponse(data: string) {
      // Keep xterm's native OSC parser (stacked queries, OSC-set colors and
      // color formats). Only route its replies through the owner channel.
      if (!/^\x1b\](?:10|11|12);rgb:[a-f\d/]+(?:\x1b\\|\x07)$/i.test(data)) return false;
      reply(data);
      return true;
    },
    setTheme(next: TermTheme) {
      if (theme.foreground !== next.foreground || theme.background !== next.background) dirty = true;
      theme = next;
      notify();
    },
    setOwner(value: boolean) {
      if (value && !owner) dirty = true;
      owner = value;
      notify();
    },
    setReady(value: boolean) {
      if (value && !ready) dirty = true;
      ready = value;
      notify();
    },
    setReplaying(value: boolean) {
      replaying = value;
      if (!value) { dirty = true; notify(); }
    },
    snapshot: () => subscribed ? `${CSI}?2031h` : "",
    reset,
    dispose() { disposed = true; clearTimeout(timer); subscriptions.forEach(item => item.dispose()); },
  };
}
