import { useCallback, useEffect, useState } from "react";
import { readFilePreview, type FilePreview } from "../../shared/api";
import { t } from "@roost/i18n";

/**
 * 选中文件的文本内容。
 *
 * 从 `Tree` 拆出来的理由和 `useOpenFile` 一样：这是「打开的那个文件的内容」，
 * 和「目录里有哪些条目」是两件事，只是因为 `selected` 原来住在 Tree 里才挤在一起。
 *
 * **「别人负责读的文件不要在这里白读一遍」那件事已经不在这一层了。** 归外部编辑器管的
 * 文件（分子文件之类）压根不会有预览窗——`usePreviewPanes` 那边 `syncPanes(prev, skip ?
 * null : selected, root)` 就把它挡在外面了，这个 hook 连挂载都不会。所以原来的 `skip`
 * 参数一个调用点都没传过值，删掉。
 */
export function useFilePreview(root: string, path: string | null) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setPreview(null);
      setError(null);
      return;
    }
    const abort = new AbortController();
    let cancelled = false;
    readFilePreview(root, path, abort.signal)
      .then((file) => {
        if (cancelled) return;
        setPreview(file);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(reason instanceof Error ? reason.message : t.files.tree.readFileFailed);
      });
    // 换文件时中止上一份：它的内容已经没人要了，留着只会占住连接。
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [root, path]);

  /**
   * 关闭预览时手动清掉——`path` 变 null 那一帧之前，旧内容不该还留在屏幕上。
   * 必须是恒定引用：调用方会把它放进 useCallback 的依赖里。
   */
  const clear = useCallback(() => { setPreview(null); setError(null); }, []);
  return { preview, error, clear };
}
