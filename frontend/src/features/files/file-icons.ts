/**
 * 文件扩展名 → Iconify vscode-icons 图标名映射。
 * 未匹配时回退到 default-file。
 */

const FALLBACK_ICON = "default-file";

const EXT_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "file-type-typescript",
  tsx: "file-type-reactts",
  mts: "file-type-typescript",
  cts: "file-type-typescript",
  js: "file-type-js",
  jsx: "file-type-reactjs",
  mjs: "file-type-js",
  cjs: "file-type-js",

  // 数据 / 配置
  json: "file-type-json",
  json5: "file-type-json5",
  jsonc: "file-type-json",
  yaml: "file-type-yaml",
  yml: "file-type-yaml",
  toml: "file-type-toml",
  xml: "file-type-xml",
  csv: "file-type-excel",
  env: "file-type-dotenv",

  // 文档
  md: "file-type-markdown",
  mdx: "file-type-markdown",
  txt: "default-file",
  pdf: "file-type-pdf2",
  rst: "file-type-text",

  // 样式
  css: "file-type-css",
  scss: "file-type-sass",
  sass: "file-type-sass",
  less: "file-type-less",
  styl: "file-type-stylus",

  // 标记
  html: "file-type-html",
  htm: "file-type-html",
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  astro: "file-type-astro",

  // 后端语言
  py: "file-type-python",
  pyi: "file-type-python",
  rb: "file-type-ruby",
  go: "file-type-go",
  rs: "file-type-rust",
  java: "file-type-java",
  kt: "file-type-kotlin",
  swift: "file-type-swift",
  php: "file-type-php",
  cs: "file-type-csharp",
  c: "file-type-c",
  h: "file-type-cheader",
  cpp: "file-type-cpp",
  hpp: "file-type-cppheader",
  cc: "file-type-cpp",
  m: "file-type-objectivec",
  mm: "file-type-objectivecpp",
  lua: "file-type-lua",
  pl: "file-type-perl",
  r: "file-type-r",

  // Shell
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  fish: "file-type-shell",
  ps1: "file-type-powershell",

  // 构建 / 工具
  dockerfile: "file-type-docker",
  makefile: "file-type-gnu",
  cmake: "file-type-cmake",
  gradle: "file-type-gradle",
  lock: "file-type-binary",
  lockb: "file-type-binary",

  // 图片
  svg: "file-type-svg",
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  ico: "file-type-favicon",
  bmp: "file-type-image",
  tiff: "file-type-image",

  // 压缩包
  zip: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  bz2: "file-type-zip",
  xz: "file-type-zip",
  "7z": "file-type-zip",
  rar: "file-type-zip",

  // 数据库
  sql: "file-type-sql",
  db: "file-type-sqlite",
  sqlite: "file-type-sqlite",
  sqlite3: "file-type-sqlite",

  // 字体
  ttf: "file-type-font",
  otf: "file-type-font",
  woff: "file-type-font",
  woff2: "file-type-font",

  // 二进制 / 其他
  bin: "default-file",
  exe: "default-file",
  dll: "default-file",
  so: "default-file",
  dylib: "default-file",
  wasm: "default-file",
  class: "file-type-java",
  jar: "file-type-java",
};

/** 特殊文件名 → 图标（优先于扩展名匹配） */
const NAME_MAP: Record<string, string> = {
  "package.json": "file-type-npm",
  "package-lock.json": "file-type-npm",
  "tsconfig.json": "file-type-tsconfig",
  "vite.config.ts": "file-type-vite",
  "vite.config.js": "file-type-vite",
  "vitest.config.ts": "file-type-vitest",
  "vitest.config.js": "file-type-vitest",
  "jest.config.js": "file-type-jest",
  "jest.config.ts": "file-type-jest",
  ".eslintrc": "file-type-eslint",
  ".eslintrc.json": "file-type-eslint",
  "eslint.config.js": "file-type-eslint",
  "eslint.config.mjs": "file-type-eslint",
  "eslint.config.ts": "file-type-eslint",
  ".prettierrc": "file-type-prettier",
  ".prettierrc.json": "file-type-prettier",
  "prettier.config.js": "file-type-prettier",
  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".gitmodules": "file-type-git",
  "dockerfile": "file-type-docker",
  "docker-compose.yml": "file-type-docker",
  "docker-compose.yaml": "file-type-docker",
  "makefile": "file-type-gnu",
  "cmakelists.txt": "file-type-cmake",
  "pnpm-lock.yaml": "file-type-pnpm",
  "yarn.lock": "file-type-yarn",
  "bun.lockb": "file-type-bun",
  "license": "file-type-license",
  "license.md": "file-type-license",
  "readme.md": "file-type-markdown",
  "readme": "file-type-markdown",
};

/**
 * 用得上的图标名全集。构建时据此从 vscode-icons 里挑子集（见 vite.config.ts 的
 * virtual:file-icons）——整包有 1500+ 个图标，全量打进主 chunk 是几 MB 的死重量。
 */
export const USED_ICON_NAMES: readonly string[] = [
  ...new Set([...Object.values(EXT_MAP), ...Object.values(NAME_MAP), FALLBACK_ICON]),
];

export function fileIcon(name: string): string {
  const lower = name.toLowerCase();

  // 特殊文件名优先
  const byName = NAME_MAP[lower];
  if (byName) return byName;

  // 扩展名匹配
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const byExt = EXT_MAP[ext];
    if (byExt) return byExt;
  }

  return FALLBACK_ICON;
}
