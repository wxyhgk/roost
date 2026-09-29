import { useEffect, useState, type ReactNode } from "react";
import { downloadFileUrl, rawFileUrl } from "../../shared/api";
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

/*
  音频和视频共用一份：除了标签名和高度，两者要做的事一模一样。

  **不设 `preload`，交给浏览器默认的 metadata**——预加载整份会让一个几百 MB 的视频
  在打开预览的瞬间开始狂下。进度条能拖，靠的是后端的 Range 支持（见 server.ts 里
  `/api/file/raw` 那段）；没有它这个播放器在 iPad 上连播都不会播。

  播不了的时候要给条出路：绝大多数失败是**编码**不被这个浏览器支持（比如 .mov 里的
  HEVC、.mkv 里的一切），文件本身是好的，下载下来用本机播放器就能看。只说一句
  「播放失败」等于把人堵死在这儿。
*/
function MediaPreview({ file, kind }: { file: PreviewFile; kind: "audio" | "video" }) {
  const [error, setError] = useState(false);
  const src = rawFileUrl(file.root, file.path);
  useEffect(() => { setError(false); }, [src]);

  const Tag = kind === "audio" ? "audio" : "video";
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate text-caption font-medium text-text">{file.name}</span>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
        {error ? (
          <div className="flex flex-col items-center gap-2 px-2.5 py-2 text-center">
            <span className="text-body leading-[1.45] text-danger">{t.misc.media.mediaFailed}</span>
            <a href={downloadFileUrl(file.root, file.path)} download={file.name}
              className="text-caption text-text-dim underline underline-offset-2 hover:text-text">
              {t.misc.media.mediaDownload}
            </a>
          </div>
        ) : (
          <Tag
            src={src}
            controls
            className={kind === "audio" ? "w-full max-w-md" : "max-h-full max-w-full"}
            onError={() => setError(true)}
          />
        )}
      </div>
    </div>
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

/*
  扩展名必须和后端 `RAW_CONTENT_TYPES` 里那批对得上：这边认、那边不认的话，
  播放器拿到的是 `application/octet-stream`，什么都不会发生。
  `frontend/tests/media-preview.test.ts` 盯着两张表一致。
*/
export const audioPlugin: EditorPlugin = {
  match: (f) => /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i.test(f),
  language: "Audio",
  extensions: () => [],
  preview: previewOf((file) => <MediaPreview file={file} kind="audio" />),
};

export const videoPlugin: EditorPlugin = {
  match: (f) => /\.(mp4|m4v|webm|mov|ogv)$/i.test(f),
  language: "Video",
  extensions: () => [],
  preview: previewOf((file) => <MediaPreview file={file} kind="video" />),
};
