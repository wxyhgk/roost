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

/*
  **语言和主题必须写成一张显式的表，不能用模板字符串拼。**

  原来是 `await import(\`shiki/dist/langs/${lang}\`)`。这在 node 里跑得通，所以任何单元
  测试都发现不了；但打包器分析不了模板字符串里的**裸包名**（相对路径它还能 glob，裸包名
  不行），于是产物里原样留下一个裸规范符，浏览器解析不了 → promise 被 reject →
  被下面那个 `try/catch` 吞掉 → `highlight()` 永远返回 null。

  结果是：**代码高亮在生产环境从来没工作过，而 165 KB 的 shiki 照样下载**。第一条带围栏
  代码的消息会触发下载、创建 highlighter，然后一个高亮都渲染不出来，且不报任何错。
  dist/assets 里也确实一个 lang/theme 分片都没有——这是最直接的证据。

  写成显式的表之后，每一项都是一个静态的 `import()`，打包器认得出、会各自切成一个分片，
  用到哪个下哪个。代价是新增语言要来这里加一行；那正是这张表该付的代价。
*/
const THEMES: Record<ThemeId, () => Promise<{ default: unknown }>> = {
  "github-dark": () => import("shiki/dist/themes/github-dark.mjs"),
  "github-light": () => import("shiki/dist/themes/github-light.mjs"),
};

/** 这个产品里实际会出现的语言。认不出的语言按纯文本处理，不报错。 */
const LANGS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
};

/** 这个语言我们支不支持。`detectLang` 会把扩展名原样透出来，所以要先问一句。 */
const supportsLang = (lang: string): boolean => Object.hasOwn(LANGS, lang);

async function ensureTheme(hl: Highlighter, theme: ThemeId): Promise<void> {
  if (loadedThemes.has(theme)) return;
  const mod = await THEMES[theme]();
  await hl.loadTheme(mod.default as never);
  loadedThemes.add(theme);
}

async function ensureLang(hl: Highlighter, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  const load = LANGS[lang];
  if (!load) return;
  const mod = await load();
  await hl.loadLanguage(mod.default as never);
  loadedLangs.add(lang);
}


/** 供 code-highlight.ts 动态导入；语言与主题的惰性加载仍在这一侧。 */
export async function highlight(code: string, lang: string, theme: "dark" | "light"): Promise<string | null> {
  const hl = await getHighlighter();
  try {
    const themeId: ThemeId = theme === "dark" ? "github-dark" : "github-light";
    await ensureTheme(hl, themeId);
    // 不支持的语言按纯文本高亮：仍然有主题配色和结构，只是没有语法着色。
    // 直接拿未加载的语言去 codeToHtml 会抛，然后被下面吞掉——那又回到「静默不工作」。
    await ensureLang(hl, lang);
    return hl.codeToHtml(code, { lang: supportsLang(lang) ? lang : "text", theme: themeId });
  } catch {
    return null;
  }
}
