import { useEffect, useState } from "react";
import { IconFile } from "../../shared/icons";
import { useTheme } from "../../shared/theme";
import { fileIcon } from "./file-icons";
import { highlightCode } from "../../shared/code-highlight";
import { icons as vscodeIcons } from "virtual:file-icons";

export function FileIcon({ name }: { name: string }) {
  const iconName = fileIcon(name);
  const icon = vscodeIcons[iconName];
  if (!icon) return <IconFile />;
  return (
    <span className="mono-icon inline-flex text-text-dim" aria-hidden>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: icon.body }}
      />
    </span>
  );
}

export function HighlightedCode({ code, filename }: { code: string; filename: string }) {
  const { theme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, filename, theme).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, filename, theme]);

  if (!html)
    return (
      <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] p-3 font-mono text-[12.5px] leading-[1.55]">
        {code}
      </pre>
    );
  return (
    <div
      className="code-highlight"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
