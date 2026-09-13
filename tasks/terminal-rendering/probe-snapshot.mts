/** Read-only investigation: isolated terminals, no PTY, socket or application database. */
import headless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';
import { createScreenStore } from '../../packages/terminal-runtime/src/screen.ts';
import { createReplayStore } from '../../packages/terminal-runtime/src/replay.ts';

const { Terminal } = headless;
type Term = InstanceType<typeof Terminal>;
const write = (term: Term, data: string) => new Promise<void>(resolve => term.write(data, resolve));
function make(cols: number, rows: number, unicode11 = true) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  if (unicode11) {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  }
  return term;
}
const visibleLines = (term: Term) => Array.from({ length: term.rows }, (_, row) => ({
  row: row + 1,
  text: term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true),
})).filter(line => line.text);
const composer = '\x1b[?1049h\x1b[1;1HHEADER\x1b[22;1HINPUT\x1b[23;1HBOTTOM_BORDER\x1b[24;1HSTATUS\x1b[22;7H';

for (const sample of [
  { name: 'unicode_same_grid', cols: 80, rows: 24, data: 'A🙂B\x1b[1;5HX' },
  { name: 'ascii_smaller_grid', cols: 60, rows: 18, data: composer },
  { name: 'ascii_same_grid_control', cols: 80, rows: 24, data: composer },
]) {
  const screen = createScreenStore();
  const replay = createReplayStore({
    getTerminalReplay: () => null, setTerminalReplay() {}, deleteTerminalReplay() {},
  }, screen);
  const live = make(80, 24), restored = make(sample.cols, sample.rows);
  try {
    replay.hydrate('probe');
    const instance = replay.getInstanceId('probe')!;
    const output = replay.append('probe', sample.data)!;
    screen.write('probe', instance, sample.data, output.seq, 80, 24);
    await write(live, sample.data);
    // Wait for the independent server parser, rather than assuming timer ordering.
    const deadline = Date.now() + 2000;
    while (screen.snapshot('probe')?.seq !== output.seq) {
      if (Date.now() >= deadline) throw new Error('Server parser did not finish');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const packet = replay.resume('probe')!;
    await write(restored, packet.data);
    console.log(JSON.stringify({ sample: sample.name, sourceGrid: [80, 24],
      destinationGrid: [sample.cols, sample.rows], packetFields: Object.keys(packet),
      live: visibleLines(live), restored: visibleLines(restored),
      cursor: { live: [live.buffer.active.cursorX, live.buffer.active.cursorY],
        restored: [restored.buffer.active.cursorX, restored.buffer.active.cursorY] } }));
  } finally {
    live.dispose(); restored.dispose(); replay.dispose(); screen.dispose();
  }
}

// Control: changing only the server Unicode provider removes the one-cell error.
for (const unicode11 of [false, true]) {
  const server = make(80, 24, unicode11), restored = make(80, 24);
  try {
    const serializer = new SerializeAddon(); server.loadAddon(serializer);
    await write(server, 'A🙂B\x1b[1;5HX');
    await write(restored, serializer.serialize());
    console.log(JSON.stringify({ control: 'unicode_provider', serverUnicode: server.unicode.activeVersion,
      restored: visibleLines(restored), cursorX: restored.buffer.active.cursorX }));
  } finally { server.dispose(); restored.dispose(); }
}
