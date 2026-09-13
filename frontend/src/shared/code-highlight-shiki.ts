/*
  shiki 那一半。

  单独成一个模块，是为了让 `code-highlight.ts` 能**动态**导入它——静态导入会把整个
  shiki 栈（vscode-textmate、oniguruma-to-es、hast-util-to-html…）钉在首屏 chunk 里，
  而它只在真正要渲染高亮代码时才用得上。实测这一拆省 54 KB（gzip）。

  这里的内容是原样搬过来的，没有改逻辑。
*/
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type ThemeId = "github-dark" | "github-light";

async function createHighlighter() {
  const engine = createJavaScriptRegexEngine();
  return createHighlighterCore({
    themes: [] as const,
    langs: [] as const,
    engine,
  });
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();
const loadedThemes = new Set<ThemeId>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter();
  }
  return highlighterPromise;
}

async function ensureTheme(hl: Highlighter, theme: ThemeId): Promise<void> {
  if (loadedThemes.has(theme)) return;
  const mod = await import(`shiki/dist/themes/${theme}`);
  await hl.loadTheme(mod.default);
  loadedThemes.add(theme);
}

async function ensureLang(hl: Highlighter, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  if (lang === "plaintext" || lang === "text") return;
  const mod = await import(`shiki/dist/langs/${lang}`);
  await hl.loadLanguage(mod.default);
  loadedLangs.add(lang);
}


/** 供 code-highlight.ts 动态导入；语言与主题的惰性加载仍在这一侧。 */
export async function highlight(code: string, lang: string, theme: "dark" | "light"): Promise<string | null> {
  const hl = await getHighlighter();
  try {
    const themeId: ThemeId = theme === "dark" ? "github-dark" : "github-light";
    await ensureTheme(hl, themeId);
    await ensureLang(hl, lang);
    return hl.codeToHtml(code, { lang, theme: themeId });
  } catch {
    return null;
  }
}
