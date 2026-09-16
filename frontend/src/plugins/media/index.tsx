import { useEffect, useState, type ReactNode } from "react";
import { rawFileUrl } from "../../shared/api";
import type { EditorPlugin, PreviewFile } from "../../shared/editor";
import { t } from "@roost/i18n";

function ImagePreview({ file }: { file: PreviewFile }) {
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const src = rawFileUrl(file.root, file.path);

  useEffect(() => {
    setError(null);
    setDims(null);
  }, [src]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate text-caption font-medium text-text">{file.name}</span>
        {dims && (
          <span className="ml-auto shrink-0 font-mono text-caption text-text-dim">
            {dims.w}×{dims.h}
          </span>
        )}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
        {error ? (
          <div className="px-2.5 py-2 text-body leading-[1.45] text-danger">{error}</div>
        ) : (
          <img
            src={src}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
            onLoad={(e) => {
              const img = e.currentTarget;
              setDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError(t.misc.media.imageFailed)}
          />
        )}
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: PreviewFile }) {
  const [error, setError] = useState<string | null>(null);
  const src = rawFileUrl(file.root, file.path);

  useEffect(() => {
    setError(null);
  }, [src]);

  // Native browser viewer; backend serves application/pdf inline.
  // No onError exists for iframes, so this only guards a missing file ctx.
  if (error) {
    return <div className="px-2.5 py-2 text-body leading-[1.45] text-danger">{error}</div>;
  }
  return (
    <iframe
      src={src}
      title={file.name}
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
  );
}

function previewOf(render: (file: PreviewFile) => ReactNode) {
  return (_content: string, file?: PreviewFile) =>
    file ? render(file) : <div className="px-2.5 py-2 text-body text-text-dim">{t.misc.media.binary}</div>;
}

export const imagePlugin: EditorPlugin = {
  match: (f) => /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(f),
  language: "Image",
  extensions: () => [],
  preview: previewOf((file) => <ImagePreview file={file} />),
};

export const pdfPlugin: EditorPlugin = {
  match: (f) => /\.pdf$/i.test(f),
  language: "PDF",
  extensions: () => [],
  preview: previewOf((file) => <PdfPreview file={file} />),
};
