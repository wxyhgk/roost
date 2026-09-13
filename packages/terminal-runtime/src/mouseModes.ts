// Input modes outlive bounded screen history: a TUI may enable them only once.
const MODES = [9, 1000, 1002, 1003, 1005, 1006, 1007, 1015, 1016];
const TRACKING = [9, 1000, 1002, 1003];
export function createMouseModes() {
  const enabled = new Set<number>();
  let seen = false;
  let state: 'text' | 'escape' | 'escapeIntermediate' | 'csi' | 'string' | 'stringEscape' = 'text';
  let params = '';
  let osc = false;
  let repairPending = false;

  function restoration() {
    if (!seen) return '';
    const active = MODES.filter(mode => enabled.has(mode));
    return `\x1b[?${MODES.join(';')}l` + (active.length ? `\x1b[?${active.join(';')}h` : '');
  }

  function consume(char: string) {
    if (char === '\x18' || char === '\x1a') { state = 'text'; return; }
    if (state === 'string' || state === 'stringEscape') {
      if ((osc && char === '\x07') || (state === 'stringEscape' && char === '\\')) state = 'text';
      else state = char === '\x1b' ? 'stringEscape' : 'string';
      return;
    }
    if (char === '\x1b') { state = 'escape'; return; }
    // C0 controls do not complete a pending escape/CSI sequence.
    if (char < ' ' || char === '\x7f') return;
    if (state === 'escape') {
      if (char === '[') { state = 'csi'; params = ''; }
      else if (']PX^_'.includes(char)) { state = 'string'; osc = char === ']'; }
      else if (char >= ' ' && char <= '/') state = 'escapeIntermediate';
      else {
        if (char === 'c') { enabled.clear(); seen = true; }
        state = 'text';
      }
      return;
    }
    if (state === 'escapeIntermediate') {
      if (char >= '0' && char <= '~') state = 'text';
      return;
    }
    if (state !== 'csi') return;
    if (char >= '@' && char <= '~') {
      if ((char === 'h' || char === 'l') && /^\?[\d;]+$/.test(params)) {
        for (const part of params.slice(1).split(';')) {
          const mode = Number(part);
          if (!MODES.includes(mode)) continue;
          seen = true;
          // Match xterm's mutually exclusive tracking and encoding protocols.
          if (TRACKING.includes(mode)) for (const tracking of TRACKING) enabled.delete(tracking);
          if ([1006, 1016].includes(mode)) { enabled.delete(1006); enabled.delete(1016); }
          if (char === 'h') enabled.add(mode); else enabled.delete(mode);
        }
      }
      state = 'text';
    } else {
      // Bound memory without treating an overlong unfinished CSI as plain text.
      params = params.length < 128 ? params + char : '!';
    }
  }

  return {
    absorb(data: string): string {
      let injected = '';
      let boundary = -1;
      let offset = 0;
      for (const char of data) {
        consume(char);
        offset += char.length;
        if (repairPending && state === 'text') {
          repairPending = false;
          boundary = offset;
          injected = restoration();
        }
      }
      return boundary < 0 ? data : data.slice(0, boundary) + injected + data.slice(boundary);
    },
    restore() {
      if (!seen) return '';
      // Never splice DEC sequences into a partial CSI, OSC or DCS. Repair at
      // the next safe output boundary, in the same sequenced stream for peers.
      if (state !== 'text') { repairPending = true; return ''; }
      return restoration();
    },
  };
}
