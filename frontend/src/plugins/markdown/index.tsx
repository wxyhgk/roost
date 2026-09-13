import { lazy, Suspense } from "react";
import { t } from "@roost/i18n";
import type { EditorPlugin, PreviewFile } from "../../shared/editor";

// markdown-it 加上 shiki 的按需加载不该进主包——构建已经在为分块体积告警了。
const Preview = lazy(() =>
  import("./markdown").then(({ markdownPlugin }) => ({
    default: ({ content, file }: { content: string; file: PreviewFile }) =>
      <>{markdownPlugin.preview?.(content, file)}</>,
  })),
);

export const markdownPlugin: EditorPlugin = {
  match: filename => /\.(md|markdown|mdown|mkd)$/i.test(filename),
  language: "Markdown",
  extensions: () => [],
  preview: (content, file) =>
    file
      ? <Suspense fallback={<div className="p-3 text-text-dim">{t.files.markdown.loading}</div>}>
          <Preview content={content} file={file} />
        </Suspense>
      : null,
};
