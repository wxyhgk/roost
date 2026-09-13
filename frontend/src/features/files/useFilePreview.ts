import { useCallback, useEffect, useState } from "react";
import { readFilePreview, type FilePreview } from "../../shared/api";
import { t } from "@roost/i18n";

/**
 * 选中文件的文本内容。
 *
 * `skip` 用来让出那些**别人负责读**的文件：分子文件交给编辑器，而编辑器自己必然要
 * 按格式解析、要记 mtime 做冲突检测，所以它会自己读一遍。这里再读一遍拿到的内容
 * 根本不会被渲染（预览弹窗在那种情况下不挂），纯粹是每次选中都白跑一个往返。
 *
 * 从 `Tree` 拆出来的理由和 `useOpenFile` 一样：这是「打开的那个文件的内容」，
 * 和「目录里有哪些条目」是两件事，只是因为 `selected` 原来住在 Tree 里才挤在一起。
 */
export function useFilePreview(root: string, path: string | null, skip = false) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path || skip) {
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
  }, [root, path, skip]);

  /**
   * 关闭预览时手动清掉——`path` 变 null 那一帧之前，旧内容不该还留在屏幕上。
   * 必须是恒定引用：调用方会把它放进 useCallback 的依赖里。
   */
  const clear = useCallback(() => { setPreview(null); setError(null); }, []);
  return { preview, error, clear };
}
