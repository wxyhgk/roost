import { watch, statSync, realpathSync, type FSWatcher } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isHidden } from './fs';

export type TreeChangeListener = () => void;
type Subscriber = { change: TreeChangeListener; error?: () => void };
type Room = {
  root: string;
  directories: Set<Directory>;
  listeners: Set<Subscriber>;
  timer: ReturnType<typeof setTimeout> | null;
};
type Directory = {
  path: string;
  watcher: FSWatcher;
  rooms: Set<Room>;
  children: Map<string, Directory>;
  parent?: Directory;
};
const visible = (name: string) => !name.startsWith('.') && !isHidden(name);
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Watch visible directories only. Native recursive watch traverses ignored trees
 * before filtering events, which can block HTTP and exhaust Linux inotify. */
export function createFileWatcher({ debounceMs = 150, maxDirectories = 4096 } = {}) {
  const rooms = new Map<string, Room>();
  // Canonical roots and non-symlink children share one physical handle, even
  // when different rooms subscribe to overlapping directory trees.
  const directories = new Map<string, Directory>();
  const pending = new Set<Directory>();
  let disposed = false, scanning = false;
  const active = (room: Room) => !disposed && rooms.get(room.root) === room;
  const current = (dir: Directory) => !disposed && directories.get(dir.path) === dir;

  function release(dir: Directory, room: Room) {
    room.directories.delete(dir);
    dir.rooms.delete(room);
    if (dir.rooms.size) return;
    directories.delete(dir.path);
    pending.delete(dir);
    dir.parent?.children.delete(dir.path);
    for (const child of dir.children.values()) child.parent = undefined;
    dir.children.clear();
    dir.watcher.close();
  }
  function close(room: Room) {
    rooms.delete(room.root);
    if (room.timer) clearTimeout(room.timer);
    // Explicit membership works for filesystem roots too; no '/' + '/' prefix
    // comparison, and no search through unrelated directories during cleanup.
    for (const dir of room.directories) release(dir, room);
  }
  function fail(room: Room) {
    if (!active(room)) return;
    close(room);
    for (const listener of [...room.listeners]) {
      try { listener.error?.(); } catch { /* Isolate consumers. */ }
    }
  }
  function failOwners(dir: Directory) {
    for (const room of [...dir.rooms]) fail(room);
  }
  function remove(dir: Directory) {
    // Snapshot before releasing references: closing a parent detaches its child
    // index, while a nested room may still own some of those children.
    const removed: Directory[] = [], todo = [dir];
    while (todo.length) {
      const entry = todo.pop()!;
      removed.push(entry);
      todo.push(...entry.children.values());
    }
    for (const entry of removed) {
      for (const room of [...entry.rooms]) {
        if (room.root === entry.path) fail(room);
        else release(entry, room);
      }
    }
  }
  function notify(room: Room) {
    if (!active(room) || room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!active(room)) return;
      for (const listener of [...room.listeners]) {
        try { listener.change(); } catch { /* Isolate consumers. */ }
      }
    }, debounceMs);
    room.timer.unref?.();
  }
  function attach(dir: Directory, room: Room) {
    const todo = [dir];
    while (todo.length) {
      const entry = todo.pop()!;
      if (entry.rooms.has(room)) continue;
      entry.rooms.add(room);
      room.directories.add(entry);
      todo.push(...entry.children.values());
    }
  }
  function add(path: string) {
    const existing = directories.get(path);
    if (existing) return existing;
    if (directories.size >= maxDirectories) throw new Error('file watch directory limit reached');
    const watcher = watch(path, { persistent: false });
    const dir: Directory = { path, watcher, rooms: new Set(), children: new Map() };
    directories.set(path, dir);
    pending.add(dir);
    watcher.on('change', (event, filename) => {
      if (!current(dir)) return;
      const name = filename?.toString();
      if (name && !visible(name)) return;
      for (const room of dir.rooms) notify(room);
      // A rename may add/remove directories. Reconcile only the affected parent.
      if (event === 'rename' || !name) { pending.add(dir); void scan(); }
    });
    watcher.on('error', () => { if (current(dir)) failOwners(dir); });
    return dir;
  }
  async function scanDirectory(dir: Directory) {
    const children = new Set<string>();
    try {
      // Streaming enumeration bounds memory for large directories and yields
      // to HTTP/PTY work. Symlinks and hidden/dependency trees are not walked.
      for await (const entry of await opendir(dir.path)) {
        if (!current(dir)) return;
        if (!entry.isDirectory() || !visible(entry.name)) continue;
        const path = join(dir.path, entry.name);
        let child: Directory;
        try { child = add(path); }
        catch (error) {
          // A child can vanish after enumeration. This says nothing about the
          // parent: never interpret watch(child)'s ENOENT as opendir(parent)'s.
          if (missing(error)) continue;
          failOwners(dir);
          return;
        }
        children.add(path);
        dir.children.set(path, child);
        child.parent = dir;
        for (const room of dir.rooms) attach(child, room);
      }
    } catch (error) {
      if (!current(dir)) return;
      if (missing(error)) remove(dir);
      else failOwners(dir);
      return;
    }
    if (!current(dir)) return;
    // Direct-child indexing keeps reconciliation linear in entries scanned,
    // instead of inspecting every watcher for every directory (quadratic).
    for (const child of [...dir.children.values()]) {
      if (!children.has(child.path)) remove(child);
    }
    for (const room of dir.rooms) notify(room);
  }
  async function scan() {
    if (disposed || scanning) return;
    scanning = true;
    try {
      while (!disposed && pending.size) {
        const dir = pending.values().next().value!;
        pending.delete(dir);
        if (current(dir)) await scanDirectory(dir);
      }
    } finally { scanning = false; }
  }

  function watchRoot(root: string, change: TreeChangeListener, error?: () => void): () => void {
    if (disposed) throw new Error('watcher disposed');
    const key = realpathSync(resolve(root));
    let room = rooms.get(key);
    if (!room) {
      if (!statSync(key).isDirectory()) throw new Error('watch root must be a directory');
      room = { root: key, directories: new Set(), listeners: new Set(), timer: null };
      rooms.set(key, room);
      try { attach(add(key), room); } catch (error) { close(room); throw error; }
    }
    const owned = room, subscriber = { change, error };
    owned.listeners.add(subscriber);
    void scan();
    return () => {
      if (rooms.get(key) !== owned) return;
      owned.listeners.delete(subscriber);
      if (!owned.listeners.size) close(owned);
    };
  }
  return {
    watch: watchRoot,
    get size() { return rooms.size; },
    get directoryCount() { return directories.size; },
    dispose() { disposed = true; for (const room of rooms.values()) close(room); },
  };
}
export type FileWatcher = ReturnType<typeof createFileWatcher>;
