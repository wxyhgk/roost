/*
  把一次拖放读成「要上传的文件清单」，文件夹递归展开。

  `dataTransfer.files` 只有文件——拖一个文件夹进来，那个列表里要么什么都没有，要么是一个
  读不出内容的条目。要拿到文件夹只能走 `webkitGetAsEntry()`。

  这条路上有三个坑，每一个的表现都是**静默少传**，而且都在小样本上测不出来：

  1. **entry 必须在 drop 事件里同步取完。** `dataTransfer.items` 在事件回调返回后就失效，
     中间 `await` 一次就全没了。所以拆成两步：`collectDropEntries` 同步取，`readDropTree`
     慢慢遍历。
  2. **`readEntries` 要反复读到返回空。** 它一次最多给 100 条（Chrome），只读一次的话，
     超过 100 个条目的目录会安静地少掉后面那些——而你拿三五个文件测是永远发现不了的。
  3. **相对路径自己在遍历时拼**，别信 `entry.fullPath`：它带着一个前导斜杠，而且在不同
     浏览器上对拖放根的表示并不一致。
*/

/** 给确认框用的人话尺寸。确认框要回答的是「这值不值得等」，不是精确到字节。 */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 我们只用到 FileSystemEntry 的这一小块；写出来是为了不把整个 DOM 类型拖进签名。 */
type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(resolve: (file: File) => void, reject: (error: unknown) => void): void;
  createReader?(): { readEntries(resolve: (entries: Entry[]) => void, reject: (error: unknown) => void): void };
};

export type DroppedFile = { path: string; file: File };

export type DropTree = {
  files: DroppedFile[];
  /** 需要先建出来的目录，**已按深度排序**，直接顺着建即可。 */
  directories: string[];
  totalBytes: number;
  /** 名字以点开头的文件数。用来在确认框里单独说一句，不做过滤。 */
  hidden: number;
  /** 撞上遍历上限而停下了——清单是不全的，调用方必须说出来。 */
  stopped: boolean;
};

/** 目录层数上限。符号链接可以成环，没有这个就会转到天荒地老。 */
const MAX_DEPTH = 24;
/** 遍历本身的硬上限。闸门（要不要问用户）是调用方的事，这个是防跑飞。 */
const MAX_ENTRIES = 20_000;

/**
 * **同步**把这次拖放里的 entry 取出来。必须在 drop 事件的回调里直接调。
 *
 * 拖的是应用内部的东西（比如树上的节点拖去终端）时这里会是空的——那种拖放没有 Files。
 */
export function collectDropEntries(items: DataTransferItemList | null | undefined): Entry[] {
  const entries: Entry[] = [];
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return entries;
}

const readEntriesOnce = (reader: ReturnType<NonNullable<Entry["createReader"]>>) =>
  new Promise<Entry[]>(resolve => reader.readEntries(resolve, () => resolve([])));

const fileOf = (entry: Entry) =>
  new Promise<File | null>(resolve => entry.file?.(resolve, () => resolve(null)) ?? resolve(null));

/** 目录一次读不完——读到返回空为止。**只读一次就是坑 2。** */
async function readAll(entry: Entry): Promise<Entry[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const all: Entry[] = [];
  for (;;) {
    const batch = await readEntriesOnce(reader);
    if (!batch.length) return all;
    all.push(...batch);
    if (all.length > MAX_ENTRIES) return all;
  }
}

/** 遍历拖进来的东西，展开成文件清单加需要先建的目录。 */
export async function readDropTree(entries: Entry[]): Promise<DropTree> {
  const files: DroppedFile[] = [];
  const directories = new Set<string>();
  let totalBytes = 0;
  let hidden = 0;
  let stopped = false;

  async function walk(entry: Entry, prefix: string, depth: number) {
    if (stopped) return;
    if (files.length >= MAX_ENTRIES || depth > MAX_DEPTH) { stopped = true; return; }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await fileOf(entry);
      // 读不出来的条目跳过而不是整次拖放失败：一个坏条目不该拖垮其余的。
      if (!file) return;
      files.push({ path, file });
      totalBytes += file.size;
      if (entry.name.startsWith(".")) hidden++;
      return;
    }
    if (!entry.isDirectory) return;
    directories.add(path);
    for (const child of await readAll(entry)) await walk(child, path, depth + 1);
  }

  for (const entry of entries) await walk(entry, "", 0);
  return {
    files,
    // 浅的排在前面，调用方顺着建就不会缺父目录。
    directories: [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    totalBytes, hidden, stopped,
  };
}
