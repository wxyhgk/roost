export const SNIPPET_LANGS = [
  "plaintext",
  "bash",
  "python",
  "javascript",
  "typescript",
  "json",
  "markdown",
] as const;

const LANG_EXT: Record<string, string> = {
  bash: "sh",
  python: "py",
  javascript: "js",
  typescript: "ts",
  json: "json",
  markdown: "md",
  plaintext: "txt",
};

export function snippetFilename(lang: string): string {
  return `snippet.${LANG_EXT[lang] ?? "txt"}`;
}
