/*
  前端产物的体积拆解：每个 chunk 里的东西按 npm 包 / 源码目录归并，从大到小列出来。
  看「首屏那几百 KB 到底是谁」用的。

    node scripts/chunk-breakdown.mjs              # 所有 chunk，按大小降序
    node scripts/chunk-breakdown.mjs main bridge  # 只看文件名含这些子串的

  不装任何分析插件（rollup-plugin-visualizer 之类）——rollup 的 bundle 对象本来就带
  `modules[].renderedLength`，要的明细已经在手里了。

  **`write: false` 是这个脚本的要害，别顺手去掉。** 在这个仓库里 `npm run build` 会就地
  改写 `frontend/dist/index.html` 里的哈希，而 Caddy 的 `/assets/*` 指向
  `~/.local/share/roost/assets`（另一个目录），于是「只构建不发布」会让正在服务的页面
  立刻 404——比不构建更糟。走内存就不碰 dist，量体积不会弄坏线上那份。

  **`renderedLength` 是压缩前、也是 minify 前的量。** 各组加起来会明显超过那个 chunk 的
  最终大小（实测 CodeMirror 那个 chunk 最终 314 KB，模块加起来 855 KB）。它给的是**排序
  和占比**，不是最终字节数；要最终数字请直接量产物：

    gzip -c frontend/dist/assets/<name> | wc -c
*/
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));

/*
  切进 frontend 再构建，这样在仓库任何目录下跑都是同一个结果。

  用 chdir 而不是传 root——vite.config.ts 里的 `rollupOptions.input` 写的是相对路径
  （`index.html` / `molecule.html`），rollup 按**进程 CWD** 解析它，不按 root。传 root
  会直接 UNRESOLVED_ENTRY。另一条路是在这里传绝对路径的 input，但那等于把入口清单抄
  第三份（vite.config、stable-workbench/build.mjs 已经各有一份），加 embed 时必漏。
*/
process.chdir(frontend);
const result = await build({
  configFile: frontend + 'vite.config.ts',
  logLevel: 'error',
  build: { write: false },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output ?? []);
const chunks = outputs.filter(o => o.type === 'chunk');

const want = process.argv.slice(2);
for (const chunk of chunks.sort((a, b) => b.code.length - a.code.length)) {
  const name = chunk.fileName;
  if (want.length && !want.some(w => name.includes(w))) continue;
  console.log(`\n===== ${name}  ${(chunk.code.length / 1024).toFixed(1)} KB raw`);
  const rows = Object.entries(chunk.modules)
    .map(([id, m]) => [id, m.renderedLength])
    .filter(([, size]) => size > 0)
    .sort((a, b) => b[1] - a[1]);
  // 按 npm 包 / 源码目录归并。scope 要连着包名一起认，否则 @xterm/xterm 和
  // @xterm/addon-webgl 会被压成同一个 `@xterm`，正好看不出是谁重。
  const groups = new Map();
  for (const [id, size] of rows) {
    const npm = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    const key = npm ? `npm:${npm[1]}` : id.replace(/.*\/frontend\/src\//, 'src/').replace(/.*\/packages\//, 'packages/');
    groups.set(key, (groups.get(key) ?? 0) + size);
  }
  for (const [key, size] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 22))
    console.log(`  ${(size / 1024).toFixed(1).padStart(8)} KB  ${key}`);
}
