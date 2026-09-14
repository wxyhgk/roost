import { defineConfig, type Plugin } from "vite";
import compression from "compression";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { icons as vscodeIconSet } from "@iconify-json/vscode-icons";
import { USED_ICON_NAMES } from "./src/features/files/file-icons";

// vscode-icons 整包有 1500+ 个图标（icons.json 约 3.7MB），文件树只用到 66 个。
// 静态 import 会把全部打进主 chunk，所以构建时按 USED_ICON_NAMES 裁一份出来。
function fileIconSubset(): Plugin {
  const id = "virtual:file-icons";
  const resolved = "\0" + id;
  return {
    name: "roost:file-icon-subset",
    resolveId: source => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null;
      const all = (vscodeIconSet as unknown as { icons: Record<string, { body: string }> }).icons;
      const missing = USED_ICON_NAMES.filter(name => !all[name]);
      if (missing.length) this.error(`vscode-icons 缺少这些图标: ${missing.join(", ")}`);
      const subset = Object.fromEntries(USED_ICON_NAMES.map(name => [name, { body: all[name].body }]));
      return `export const icons = ${JSON.stringify(subset)};`;
    },
  };
}

/**
 * 修 ketcher-core 的 raphael 互操作。
 *
 * `raphael-ext.modern.js` 是个货真价实的 ES 模块（顶部 `import`、底部 `export`），
 * 却用 CommonJS 的 `require('raphael')` 去取依赖。浏览器里没有 `require`，于是
 * 分子编辑器一加载就报 `Can't find variable: require`——上游的打包 bug，不是配置问题。
 *
 * 只替换那一个表达式，upstream 自己的逻辑（`typeof window` 判断、`resolveRaphael`、
 * `Raphael.el.translateAbs` 那几段）原样留着：抄一份到本地早晚会和上游漂移。
 *
 * 换成静态 import 还顺带把 raphael 真正打进产物——原来那句 require 从来没成功过，
 * 也就是说这个依赖此前根本没被打包。
 *
 * 找到文件却找不到那句话时**直接报错**：上游改了写法的话，静默跳过等于把
 * 同一个崩溃放回去，而且下次没人知道该来这里看。
 */
function ketcherRaphaelInterop(): Plugin {
  const target = /ketcher-core[\\/]dist[\\/]application[\\/]render[\\/]raphael-ext\.modern\.js$/;
  const call = "require('raphael')";
  return {
    name: "roost:ketcher-raphael-interop",
    transform(code, id) {
      if (!target.test(id)) return null;
      if (!code.includes(call)) {
        this.error(`ketcher-core 的 raphael-ext 里找不到 ${call}：上游可能已经改了写法，请核对这个补丁还需不需要`);
      }
      return { code: `import __roostRaphael from "raphael";\n${code.replaceAll(call, "__roostRaphael")}`, map: null };
    },
  };
}

/**
 * 给 dev server 加 gzip。
 *
 * 开发模式下依赖是**逐个 chunk** 发的，不像构建产物那样合并压缩过。ketcher（分子
 * 编辑器）一个功能就要拉 10 个 chunk、约 17 MB 未压缩的 JS——本机毫秒级无所谓，
 * 但经端口映射访问时，每个多兆响应都要好几秒且会间歇性断流。一旦其中任何一个失败，
 * 浏览器只会报**父模块**的地址，于是错误指向的那个文件单独测总是好的，极难定位。
 *
 * 实测这批 chunk 压缩比在 12%~19%：17.4 MB → 2.7 MB。
 *
 * 必须在 configureServer 里直接 use（而不是返回的后置函数里），这样中间件排在 Vite
 * 自己的处理之前，才来得及包住响应流。
 */
function devCompression(): Plugin {
  return {
    name: "roost:dev-compression",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(compression());
    },
  };
}

const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT) || undefined;

export default defineConfig({
  plugins: [devCompression(), react(), tailwindcss(), fileIconSubset(), ketcherRaphaelInterop()],
  resolve: {
    alias: [
      { find: 'events', replacement: 'events/' },
      /*
        paper 的 package.json main 指向 `dist/paper-full.js`，而 full 版把 acorn 和
        PaperScript（paper 自己那套 DSL）一起打了进去。acorn 在**模块求值时**就用
        `new Function("str", …)` 现编保留字检查表——桌面版的 CSP 是
        `script-src 'self' 'wasm-unsafe-eval'`（desktop/runtime/server.mjs、
        stable-workbench/server.mjs 各一份），没有 'unsafe-eval'，于是这一句直接抛，
        `import('./frame')` 整个拒绝，界面上看到的就是「编辑器加载失败」。
        浏览器直连那条路没有 CSP 头，所以只在桌面版和 stable-workbench 里犯。

        ketcher 用到的只有几何部分（Path.Circle / Rectangle / Point / Size /
        CompoundPath / setup），PaperScript 一个都没碰，换 core 版正好去掉带 eval 的那半。
        实测 paper-core.js 里 `new Function` 出现 0 次，full 版 1 次。

        必须写成 `/^paper$/` 的精确匹配：字符串 find 会连 `paper/dist/...` 这类子路径
        一起改写，把替换结果再拼一遍。
      */
      { find: /^paper$/, replacement: 'paper/dist/paper-core.js' },
    ],
  },
  build: { rollupOptions: { input: { main: "index.html", molecule: "molecule.html" } } },
  server: {
    // Vite 默认 host 是 "localhost"，在 Node 25 上只解析到 ::1，于是 dev server 只监听
    // IPv6 回环——127.0.0.1 和网卡地址都连不上，内网穿透客户端因此拿不到连接。
    // 注意：认证只有一道——首次启动生成、存在数据目录里的那个密码（auth-config.ts）。
    // 它挡的是同一网络里的其他人，不是为公网暴露设计的；而界面可读写工作目录下的文件
    // 并向终端发送输入。暴露到局域网或公网（例如经 nps 映射）时，请在代理那一层再加
    // 一道访问控制。
    host: true,
    port: 5173,
    strictPort: true,
    // 经端口映射访问时，浏览器里的 HMR 客户端会去连「当前页面的端口」，而那通常不是
    // 5173。用环境变量告诉它对外端口，本机直连 5173 时不设置即可保持原行为。
    //   VITE_HMR_CLIENT_PORT=15173 npm run dev
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
