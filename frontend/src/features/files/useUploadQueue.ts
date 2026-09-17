import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, uploadFile, type UploadConflict, type UploadResult } from "../../shared/api/files";
import { ApiError } from "../../shared/api/errors";
import { t } from "@roost/i18n";

/**
 * 文件上传队列。
 *
 * **串行**：一次只传一个。并行既会把隧道打满，也让「卡在哪一个」看不出来；
 * 而且后端每个网关只允许 4 个并发（超出返回 429 upload_busy），串行天然撞不上。
 *
 * 同名文件会**停下来问**，而不是替用户决定：覆盖不可撤销。
 *
 * 逻辑写成不依赖 React 的驱动器，hook 只是薄薄一层。串行顺序、冲突暂停、
 * 改选项后重试、取消——这些才是容易写错的部分，抽出来才测得到。
 */

export type UploadChoice = "overwrite" | "rename" | "skip";
export type UploadState = {
  /** 正在传的那一个；null 表示队列空闲。 */
  active: { name: string; loaded: number; total: number } | null;
  /** 还排着的个数，不含正在传的那个。 */
  pending: number;
  /** 需要你决定同名怎么办的那一个。在你回答之前，队列是停住的。 */
  conflict: { name: string } | null;
  failures: { name: string; message: string }[];
};

export const IDLE_UPLOAD: UploadState = { active: null, pending: 0, conflict: null, failures: [] };

type Task = { file: { name: string; size: number }; body: Blob; directory: string };
export type UploadPort = (
  root: string, path: string, body: Blob,
  options: { conflict: UploadConflict; signal: AbortSignal; onProgress: (loaded: number, total: number) => void },
) => Promise<UploadResult>;

const join = (directory: string, name: string) => (directory ? `${directory}/${name}` : name);

export function createUploadQueue(options: {
  root: string;
  onState: (state: UploadState) => void;
  onUploaded: () => void;
  send?: UploadPort;
  maxBytes?: number;
}) {
  const send: UploadPort = options.send ?? ((root, path, body, opts) => uploadFile(root, path, body, opts));
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const queue: Task[] = [];
  let state = IDLE_UPLOAD;
  let running = false;
  let disposed = false;
  let abort: AbortController | null = null;
  let decide: ((choice: UploadChoice) => void) | null = null;

  const set = (patch: Partial<UploadState>) => {
    state = { ...state, ...patch };
    if (!disposed) options.onState(state);
  };

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        const task = queue[0]!;
        const { name, size } = task.file;
        set({ active: { name, loaded: 0, total: size }, pending: queue.length - 1 });
        try {
          // 超限的在本地就拦下：传完 64 MiB 再被拒是纯粹的浪费。
          if (size > maxBytes) throw new ApiError(413, "too_large", t.files.upload.tooLarge(name), null, null);
          let conflict: UploadConflict = "error";
          for (;;) {
            const controller = new AbortController();
            abort = controller;
            try {
              await send(options.root, join(task.directory, name), task.body, {
                conflict, signal: controller.signal,
                onProgress: (loaded, total) => set({ active: { name, loaded, total } }),
              });
              options.onUploaded();
              break;
            } catch (error) {
              // 409 不是失败，是一个待回答的问题。显式覆盖时撞上并发修改也会回到这里。
              if (!(error instanceof ApiError && error.status === 409) || disposed) throw error;
              const choice = await new Promise<UploadChoice>(resolve => {
                decide = resolve;
                set({ conflict: { name } });
              });
              decide = null;
              set({ conflict: null });
              if (choice === "skip") break;
              conflict = choice;
            } finally { abort = null; }
          }
        } catch (error) {
          // 取消是用户的意思，不该记成失败。
          if (error instanceof DOMException && error.name === "AbortError") { queue.length = 0; break; }
          set({ failures: [...state.failures, { name, message: error instanceof Error ? error.message : String(error) }] });
        }
        queue.shift();
      }
    } finally {
      running = false;
      set({ active: null, pending: 0, conflict: null });
    }
  }

  return {
    enqueue(files: { file: { name: string; size: number }; body: Blob; directory: string }[]) {
      if (!files.length || disposed) return;
      queue.push(...files);
      set({ pending: Math.max(queue.length - (running ? 1 : 0), 0) });
      void run();
    },
    resolve(choice: UploadChoice) { decide?.(choice); },
    cancel() { queue.length = 0; decide?.("skip"); abort?.abort(); },
    dismiss() { set({ failures: [] }); },
    dispose() { disposed = true; queue.length = 0; decide?.("skip"); abort?.abort(); },
  };
}

export function useUploadQueue(root: string, onUploaded: () => void) {
  const [state, setState] = useState<UploadState>(IDLE_UPLOAD);
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;
  const queue = useRef<ReturnType<typeof createUploadQueue> | null>(null);

  useEffect(() => {
    const created = createUploadQueue({ root, onState: setState, onUploaded: () => uploaded.current() });
    queue.current = created;
    setState(IDLE_UPLOAD);
    return () => { created.dispose(); queue.current = null; };
  }, [root]);

  /*
    每个条目自带它要落的目录——文件夹拖进来之后，同一批里的文件分属不同子目录。

    队列核心不用改：它本来就是 `directory + name` 拼路径，把 directory 换成
    「落点 + 相对路径的父目录」就够了。
  */
  const enqueue = useCallback((items: { file: File; directory: string }[]) => {
    queue.current?.enqueue(items.map(({ file, directory }) => ({ file: { name: file.name, size: file.size }, body: file, directory })));
  }, []);
  const resolve = useCallback((choice: UploadChoice) => queue.current?.resolve(choice), []);
  const cancel = useCallback(() => queue.current?.cancel(), []);
  const dismiss = useCallback(() => queue.current?.dismiss(), []);
  return { state, enqueue, resolve, cancel, dismiss };
}
