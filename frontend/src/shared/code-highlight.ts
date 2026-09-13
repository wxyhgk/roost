/**
 * 扩展名 → shiki 语言 ID。
 * 只列出扩展名与 shiki 语言 ID 不一致的情况；
 * 其余扩展名（json, yaml, go, rust, html, css, scss, sql, toml, xml, c, cpp, java, php, swift, lua, diff …）
 * 直接就是 shiki 语言 ID，无需映射。
 */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  jsonc: "json",
  htm: "html",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  kt: "kotlin",
  rs: "rust",
  rb: "ruby",
  patch: "diff",
};

const NAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
};

export function detectLang(filename: string): string {
  const lower = filename.toLowerCase();

  const byName = NAME_TO_LANG[lower];
  if (byName) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const mapped = EXT_TO_LANG[ext];
    if (mapped) return mapped;
    return ext;
  }

  return "plaintext";
}

/*
  高亮的门面。

  `detectLang` 是纯数据、调用方同步用（FilePreviewModal 就直接用它选语言标签），
  所以留在这一侧；shiki 那一坨只在这里**动态**导入——它是首屏里第二大的一块，
  而只有真的要画高亮时才需要。`highlightCode` 本来就是 async，调用点一处都不用改。
*/
export async function highlightCode(
  code: string,
  filename: string,
  theme: string,
): Promise<string | null> {
  const { highlight } = await import("./code-highlight-shiki");
  return highlight(code, detectLang(filename), theme === "dark" ? "dark" : "light");
}
