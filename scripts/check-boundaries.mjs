import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owners = ['packages/subscriptions', 'packages/server-monitor', 'packages/agent-messaging', 'packages/ai-transcript', 'backend', 'frontend', 'stable-workbench', 'packages/terminal-protocol', 'packages/terminal-runtime', 'packages/workspace-store', 'packages/cli-adapters', 'packages/terminal-daemon', 'packages/attachment-store', 'packages/core-server', 'packages/ai-session-bridge', 'packages/i18n'];
const allowed = {
  'packages/subscriptions': [],
  'packages/server-monitor': ['systeminformation', 'tsx/esm/api'],
  'packages/agent-messaging': ['@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/stdio.js', '@modelcontextprotocol/sdk/types.js', 'zod'],
  'packages/ai-transcript': [],
  'packages/core-server': ['@roost/terminal-daemon/client', '@roost/terminal-protocol', 'ws'],
  backend: ['@roost/subscriptions', '@roost/server-monitor', '@roost/ai-transcript', '@roost/ai-session-bridge', '@roost/attachment-store', '@roost/terminal-daemon', '@roost/cli-adapters', '@roost/terminal-protocol', '@roost/terminal-runtime', '@roost/workspace-store', 'ws'],
  frontend: ['@roost/subscriptions', '@roost/server-monitor/types', '@roost/terminal-protocol', '@roost/cli-adapters', '@roost/i18n'],
  'stable-workbench': [],
  'packages/ai-session-bridge': ['@roost/ai-transcript'],
  'packages/i18n': [],
  'packages/attachment-store': ['sharp'],
  // @xterm/headless：claude-screen.ts 用无头终端解析 Claude 的 TUI 屏幕。
  // 这份名单是手工维护的，新增外部依赖必须显式登记——这正是这道检查的意义。
  'packages/terminal-daemon': ['@roost/terminal-runtime', '@roost/terminal-protocol', '@roost/workspace-store', '@xterm/headless', 'ws'],
  'packages/cli-adapters': [],
  'packages/terminal-protocol': ['@roost/cli-adapters'],
  // @xterm/headless + addon-serialize：screen.ts 在服务端持有每个会话解析好的屏幕，
  // 重连时序列化出来一帧还原，而不是把原始历史重放给用户看。
  'packages/terminal-runtime': ['@roost/cli-adapters', '@roost/terminal-protocol', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'],
  'packages/workspace-store': ['@roost/cli-adapters', '@roost/ai-session-bridge', '@roost/terminal-protocol'],
};
const errors = [];

/*
  引用指向的东西还在不在。

  **这条比下面那些「不该依赖谁」的规则更基础，而且没有别的东西在守。** 类型检查只覆盖
  各 workspace 的 `src`：`tests/` 不在 tsconfig 里，HTML fixture 里的 `/src/...` 是
  运行时才解析的，构建配置又在 src 之外。一次目录搬迁下来，这三处断掉都只能靠跑完整套
  测试或构建才现形——本轮重构里它们一共绊了三次。

  这里不判断「该不该依赖」，只判断「依赖的文件存不存在」。
*/
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '/index.ts', '/index.tsx', '/index.js'];
function resolves(target) {
  // TypeScript 的 NodeNext 写法：`./x.js` 指的是 `./x.ts`。
  const swapped = target.replace(/\.(js|jsx|mjs|cjs)$/, (m) => ({ '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' })[m]);
  return RESOLVE_EXT.some(ext => existsSync(target + ext) || existsSync(swapped + ext));
}

function* allFiles(dir, test) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* allFiles(path, test); }
    else if (test.test(path)) yield path;
  }
}

function checkReferences(owner) {
  const base = resolve(root, owner);
  // 相对 import：src 由类型检查兜着，tests 没人兜。
  for (const dir of ['src', 'tests']) {
    for (const path of allFiles(resolve(base, dir), /\.[cm]?[jt]sx?$/)) {
      const source = readFileSync(path, 'utf8');
      for (const [, spec] of source.matchAll(/(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']*)["']/g)) {
        /*
          也允许从 workspace 根解析：有些测试把一段代码放进模板字符串交给 `node -e` 跑，
          那里的相对路径按子进程的 cwd 算，不按文件所在目录算。放宽这一档仍然能抓到
          「文件被搬走了」——搬走之后两个基准都解析不到。
        */
        if (!resolves(resolve(dirname(path), spec)) && !resolves(resolve(base, spec)))
          errors.push(`${relative(root, path)}: ${spec}: reference does not exist`);
      }
    }
  }
  /*
    指向 src 的其余写法：HTML 入口和浏览器 fixture 里的绝对 `/src/…`，构建配置里的
    `./src/…`（vite.config 从那儿取图标白名单来裁 chunk）。两者都在 tsconfig 之外，
    搬目录时只有跑起来才会现形。一律按 workspace 根解析。
  */
  const bad = (path, spec) => errors.push(`${relative(root, path)}: ${spec}: reference does not exist`);
  // 绝对 `/src/…`：HTML 入口和浏览器 fixture 里都是引用，没有别的含义。
  for (const path of allFiles(base, /\.(html|[cm]?[jt]sx?)$/)) {
    if (relative(base, path).startsWith('dist')) continue;
    for (const [, spec] of readFileSync(path, 'utf8').matchAll(/["'](\/src\/[^"']*)["']/g))
      if (!resolves(resolve(base, spec.slice(1)))) bad(path, spec);
  }
  /*
    `./src/…` 只在 workspace 根的构建配置里当引用看。**同样的写法出现在测试里往往是数据**
    （`resolveLinkTarget(cwd, "./src/b.py")`），正则分不清这两者，所以按位置分。
  */
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(config\.[cm]?[jt]s|mjs)$/.test(entry.name)) continue;
    const path = resolve(base, entry.name);
    for (const [, spec] of readFileSync(path, 'utf8').matchAll(/["'](\.{1,2}\/src\/[^"']*)["']/g))
      if (!resolves(resolve(base, spec.replace(/^\.{1,2}\//, '')))) bad(path, spec);
  }
}
for (const owner of owners) checkReferences(owner);
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.[cm]?[jt]sx?$/.test(path)) yield path;
  }
}
for (const owner of owners) {
  const base = resolve(root, owner);
  for (const path of files(resolve(base, 'src'))) {
    const source = readFileSync(path, 'utf8');
    // CLI options and quoted command names ("--import", "import") are data.
    const imports = source.matchAll(/(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g);
    for (const [, spec] of imports) {
      let reason;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(path), spec);
        if (!target.startsWith(base + sep)) reason = 'cross-workspace relative import';
        if (owner === 'frontend') {
          const from = relative(resolve(base, 'src'), path).split(sep).join('/');
          const to = relative(resolve(base, 'src'), target).split(sep).join('/');
          if (from.startsWith('features/library/') && !to.startsWith('features/library/')) reason = 'library must not depend on UI, workspace or terminal';
          /*
            **共享层不许反过来依赖特性。** 一个共享模块只要引用了某个特性，它就不再是共享的
            了，而是那个特性的一部分，只是名字骗人。`store/` 同理：工作区状态是所有特性的
            下游，不能倒过来。

            这条一度只对 `shared/ui/` 生效，因为 `shared/api/conversations.ts` 曾经反过来
            引用 `features/conversations/` 里的载荷类型，全量开启会直接红。当时没有把规则
            放宽到「刚好能过」——那等于把问题藏起来；类型的归属已经修好（载荷进
            shared/api/conversationPayloads.ts），所以现在恢复成完整版。
          */
          const FEATURE = /^(features|app|plugins)\//;
          if (from.startsWith('shared/') && FEATURE.test(to)) reason = 'a shared layer must not depend on a feature';
          if (['shared/store/state.ts', 'shared/store/observable.ts'].includes(from) && FEATURE.test(to)) reason = 'workspace state must not depend on features';
          if (from === 'features/terminal/public.ts' && /(?:xtermEngine|useTerminal|index)$/.test(to)) reason = 'light terminal entry must not load the engine';
          /*
            **只有注册表能认识具体的插件。**

            这条是「插件系统」和「一个叫 plugins 的目录」的全部区别。原来那张表拼在
            features/files/FilePreviewModal.tsx 第 13 行：消费方同时是注册方，于是「有哪些
            插件」这个问题的答案藏在文件预览弹窗里，加一个插件要改那个弹窗。搬走之后，
            如果还允许别处直接 import 某个插件，那张表就会重新长出第二份、第三份。

            插件之间也不许互相 import：一个插件被另一个插件依赖，就不再是可插拔的了。

            **注册表不止一个。** 目前两张：`index` 是渲染在预览弹窗里的插件，`external` 是
            活在弹窗之外、由 Shell 挂载的编辑器。分开不是为了好看——`Shell` 是首屏，而
            `index` 牵着 markdown / code / media 那一串本该跟着懒加载进来的东西；合成一张
            实测让首屏 gzip 从 386.3 KB 涨到 560.8 KB。谁 import 一张注册表，就决定了它牵着
            的东西落在哪个 chunk 里。

            要加第三张注册表，先问清楚它对应的是哪一种契约——只是想绕开这条检查的话，
            那正是这条检查要拦的事。
          */
          // `to` 可能不带扩展名也不带尾斜杠（`../../plugins/xyz`），所以两种形态都要认；
          // 注册表自己不是插件。
          const REGISTRY = /^plugins\/(index|external)(\.ts)?$/;
          const pluginOf = (path) => {
            const name = path.match(/^plugins\/([^/]+)(?:\/|$)/)?.[1];
            return !name || REGISTRY.test('plugins/' + name.replace(/\.ts$/, '')) ? null : name;
          };
          if (pluginOf(to) && pluginOf(to) !== pluginOf(from) && !REGISTRY.test(from))
            reason = 'only a registry may name a specific plugin';
        }
      } else {
        const node = spec.startsWith('node:') || builtinModules.includes(spec);
        if (owner === 'frontend' && /(?:features\/library\/(?:client|query|api)|shared\/store\/(?:state|observable)|features\/terminal\/sessionController)\.ts$/.test(path) && /^react(?:-dom)?(?:\/|$)/.test(spec)) reason = 'state core must remain independent of React';
        if (node && (owner === 'frontend' || owner === 'stable-workbench' || owner.endsWith('terminal-protocol') || owner.endsWith('cli-adapters'))) reason = 'Node dependency in browser code';
        else if (spec.startsWith('@roost/') && !allowed[owner].includes(spec)) reason = 'private or disallowed package entry';
        else if (owner.startsWith('packages/') && !node && !allowed[owner].includes(spec)) reason = 'undeclared package dependency';
      }
      if (reason) errors.push(`${relative(root, path)}: ${spec}: ${reason}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Workspace source boundaries passed');
