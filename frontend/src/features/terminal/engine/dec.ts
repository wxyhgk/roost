const TRACKED = new Set([
  9, 47, 1000, 1002, 1003, 1005, 1006, 1007, 1015, 1016, 1047, 1049, 2026,
]);

/*
  DECTCEM（?25）单独记，不能并进上面那个集合。

  那个集合的语义是「见过 h 就在里面」，而光标可见性的**默认是可见**——「从没提过」和
  「被 ?25l 藏起来了」在集合里长得一样，而这两者的结论正好相反。
*/
const DECTCEM = 25;

const CSI_DEC = /\x1b\[\?([\d;]+)([hl])/g;

function asText(data: string | Uint8Array) {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function absorbDec(
  text: string,
  modes: Set<number>,
  tail: { value: string },
  cursor?: { hidden: boolean },
) {
  const buf = tail.value + text;
  tail.value = buf.slice(-48);
  CSI_DEC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSI_DEC.exec(buf))) {
    const on = match[2] === "h";
    for (const part of match[1].split(";")) {
      const mode = Number(part);
      if (mode === DECTCEM && cursor) { cursor.hidden = !on; continue; }
      if (!TRACKED.has(mode)) continue;
      if (on) modes.add(mode);
      else modes.delete(mode);
    }
  }
}

export function createDecTracker() {
  const modes = new Set<number>();
  const tail = { value: "" };
  const cursor = { hidden: false };
  return {
    absorb(data: string | Uint8Array) {
      absorbDec(asText(data), modes, tail, cursor);
    },
    reset() {
      modes.clear();
      tail.value = "";
      cursor.hidden = false;
    },
    /**
     * 硬件光标还显示着吗。
     *
     * **自绘光标的 TUI 会先把它藏起来**（`?25l`），然后在自己想要的位置画一个。
     * 这时候硬件光标停在哪就没有意义了，输入法的候选框不能跟着它走。
     */
    cursorVisible() {
      return !cursor.hidden;
    },
    mouseTracking() {
      return (
        modes.has(1000) || modes.has(1002) || modes.has(1003) || modes.has(9)
      );
    },
    altScreen() {
      return modes.has(1049) || modes.has(1047) || modes.has(47);
    },
    sgrMouse() {
      return modes.has(1006);
    },
    modes,
  };
}
