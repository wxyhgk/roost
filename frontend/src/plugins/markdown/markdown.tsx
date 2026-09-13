import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import type { EditorPlugin, PreviewFile } from "../../shared/editor";
import { resolveDocPath, isExternalHref } from "./markdownPaths";
import { rawFileUrl } from "../../shared/api/files";
import { publishNav } from "../../shared/navigate";
import { renderMarkdown, useCodeHighlight } from "../../shared/markdown";
import { useTheme } from "../../shared/theme";
import { t } from "@roost/i18n";

/** 相对图片必须在渲染时就改写好，否则会先闪一批裂图再被修正。 */
function rewriteImages(md: InstanceType<typeof MarkdownIt>, file: PreviewFile) {
  type ImageRule = NonNullable<typeof md.renderer.rules.image>;
  const base: ImageRule = md.renderer.rules.image ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = ((tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const src = token.attrGet("src") ?? "";
    const resolved = typeof src === "string" ? resolveDocPath(file.path, src) : null;
    if (resolved) token.attrSet("src", rawFileUrl(file.root, resolved));
    return base(tokens, idx, options, env, self);
  }) satisfies ImageRule;
}

function MarkdownPreview({ content, file }: { content: string; file: PreviewFile }) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const html = useMemo(() => {
    try {
      const value = renderMarkdown(content, md => rewriteImages(md, file));
      setFailed(false);
      return value;
    } catch {
      setFailed(true);
      return "";
    }
  }, [content, file.root, file.path]);

  useCodeHighlight(host, html, theme);

  // 链接用事件委托，而不是给每个 <a> 挂监听：内容是整块替换的，委托不会漏。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (isExternalHref(href)) {
        // 外链走新标签页；纯锚点交给浏览器自己处理。
        if (!href.trim().startsWith("#")) {
          event.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
        return;
      }
      const resolved = resolveDocPath(file.path, href);
      if (!resolved) return;
      // 仓库内的相对链接在文件面板里直接打开，而不是把人带离应用。
      event.preventDefault();
      publishNav({ kind: "file", path: resolved });
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [file.path, html]);

  if (failed) return <div className="px-2.5 py-2 text-body text-text-dim">{t.files.markdown.renderFailed}</div>;
  return <div ref={host} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export const markdownPlugin: EditorPlugin = {
  match: filename => /\.(md|markdown|mdown|mkd)$/i.test(filename),
  language: "Markdown",
  extensions: () => [],
  preview: (content, file) =>
    file ? <MarkdownPreview content={content} file={file} /> : null,
};
