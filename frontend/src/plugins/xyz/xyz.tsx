import { useEffect, useMemo, useRef, useState } from "react";
import { parseXyz } from "./parse";
import { dmolViewer } from "./3dmol-viewer";
import { CPK, UNKNOWN_ELEMENT_COLOR } from "../../shared/chemistry/elements";
import type { StructureView } from "../../shared/chemistry/viewer";
import type { EditorPlugin } from "../../shared/editor";
import { t } from "@roost/i18n";

/*
  这个组件只认 `Structure` 和 `StructureView` 两个契约，不认任何查看器。换 3D 查看器时
  改的是 `dmolViewer` 这一行 import 和它背后的实现文件——下面的代码一行都不用动。
*/

// 查看器不该自己去读 CSS 变量（它未必跑在这个页面里），所以主题色由调用方取好递进去。
function themeBackground(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() || "#000000"
  );
}

function XyzPreview({ content }: { content: string }) {
  // 解析一次，两处共用：表头读 title/atoms，查看器拿同一个 Structure。
  // 两边看同一份判断，就不会再出现「表头好好的、视图却炸了」。
  const parsed = useMemo(() => parseXyz(content), [content]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<StructureView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !parsed) return;
    let disposed = false;

    // 等一帧再挂：容器这时才有真实尺寸，查看器按它算画布。
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        const view = dmolViewer.mount(el, { background: themeBackground() });
        viewRef.current = view;
        view.show(parsed);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      viewRef.current?.dispose();
      viewRef.current = null;
    };
  }, [parsed]);

  const resetView = () => {
    try {
      viewRef.current?.resetView();
      setError(null);
    } catch {
      // 忽略, 保持当前画面
    }
  };

  if (!parsed) {
    return (
      <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-body leading-[1.55]">
        {content}
      </pre>
    );
  }

  const counts: Record<string, number> = {};
  for (const a of parsed.atoms) counts[a.element] = (counts[a.element] ?? 0) + 1;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        {parsed.title && (
          <span className="truncate text-caption font-medium text-text">{parsed.title}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={resetView}
            title={t.misc.xyz.resetTitle}
            className="rounded px-1.5 py-0.5 font-mono text-caption text-text-dim hover:bg-bg-hover hover:text-text"
          >
            {t.misc.xyz.reset}
          </button>
          {Object.entries(counts).map(([el, n]) => (
            <span
              key={el}
              className="flex items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5 text-caption font-mono text-text"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: CPK[el] ?? UNKNOWN_ELEMENT_COLOR }}
              />
              {el}×{n}
            </span>
          ))}
        </span>
      </div>
      {error && (
        <div className="shrink-0 px-3 py-1.5 text-body leading-[1.45] text-danger">
          {t.misc.xyz.viewerError}: {error}
        </div>
      )}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

export const xyzPlugin: EditorPlugin = {
  match: (f) => /\.xyz$/i.test(f),
  language: "XYZ",
  extensions: () => [],
  preview: (content) => <XyzPreview content={content} />,
};
