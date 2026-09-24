import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owners = ['packages/subscriptions', 'packages/server-monitor', 'packages/agent-messaging', 'packages/ai-transcript', 'backend', 'frontend', 'stable-workbench', 'packages/terminal-protocol', 'packages/terminal-runtime', 'packages/workspace-store', 'packages/cli-adapters', 'packages/auth-challenge', 'packages/terminal-daemon', 'packages/attachment-store', 'packages/core-server', 'packages/ai-session-bridge', 'packages/i18n'];
const allowed = {
  'packages/subscriptions': [],
  'packages/server-monitor': ['systeminformation', 'tsx/esm/api'],
  'packages/agent-messaging': ['@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/stdio.js', '@modelcontextprotocol/sdk/types.js', 'zod'],
  'packages/ai-transcript': [],
  'packages/core-server': ['@roost/terminal-daemon/client', '@roost/terminal-protocol', 'ws'],
  backend: ['@roost/auth-challenge', '@roost/subscriptions', '@roost/server-monitor', '@roost/ai-transcript', '@roost/ai-session-bridge', '@roost/attachment-store', '@roost/terminal-daemon', '@roost/cli-adapters', '@roost/terminal-protocol', '@roost/terminal-runtime', '@roost/workspace-store', 'ws'],
  // @roost/workspace-store/types 是纯类型子入口（packages/workspace-store/src/public-types.ts）。
  // 主入口 import node:sqlite，永远不该进浏览器；但只立禁令不给路径的后果是前端手抄了一份，
  // 而手抄不会响。开这条子路径正是为了让「改了后端前端编译不过」重新成立。
  frontend: ['@roost/auth-challenge', '@roost/subscriptions', '@roost/server-monitor/types', '@roost/terminal-protocol', '@roost/cli-adapters', '@roost/i18n', '@roost/workspace-store/types'],
  'stable-workbench': [],
  'packages/ai-session-bridge': ['@roost/ai-transcript'],
  'packages/i18n': [],
  'packages/attachment-store': ['sharp'],
  // @xterm/headless：claude-screen.ts 用无头终端解析 Claude 的 TUI 屏幕。
  // 这份名单是手工维护的，新增外部依赖必须显式登记——这正是这道检查的意义。
  'packages/terminal-daemon': ['@roost/terminal-runtime', '@roost/terminal-protocol', '@roost/workspace-store', '@xterm/headless', 'ws'],
  'packages/cli-adapters': [],
  // 纯计算，不许有任何依赖：它同时跑在 Node 和浏览器里，而浏览器那边连 WebCrypto 都没有。
  'packages/auth-challenge': [],
  'packages/terminal-protocol': [],
  // @xterm/headless + addon-serialize：screen.ts 在服务端持有每个会话解析好的屏幕，
  // 重连时序列化出来一帧还原，而不是把原始历史重放给用户看。
  'packages/terminal-runtime': ['@roost/cli-adapters', '@roost/terminal-protocol', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'],
  'packages/workspace-store': ['@roost/cli-adapters', '@roost/ai-session-bridge', '@roost/terminal-protocol'],
};
/*
  **哪些工作区的代码会进浏览器。** 原来这里是手工枚举的四项（frontend / stable-workbench /
  terminal-protocol / cli-adapters），而它和上面 `allowed.frontend` 那张「前端能引哪些包」
  的名单**没有任何联动**。

  后果实测过：`packages/auth-challenge` 引 `node:crypto` 检查器一声不吭，而同一行放进
  `terminal-protocol` 当场红。偏偏 auth-challenge 自己的注释写着「它同时跑在 Node 和
  浏览器里，而浏览器那边连 WebCrypto 都没有」——规则想守的正是它，却没守到。

  改成推导：前端能引的每一个 `@roost/*` **主入口**，按定义都会被打进浏览器包，所以都受这条
  约束。以后往 `allowed.frontend` 加一项，这里自动跟上。

  **只认主入口，带子路径的不算**——这正是上面那张名单第一段注释在区分的东西：
  `@roost/workspace-store/types` 和 `@roost/server-monitor/types` 是纯类型子入口，编译期
  就擦掉了，而它们的包主入口 `import node:sqlite`、`node:child_process`，永远不该进浏览器。
  把子路径剥掉当成整包会一次报出 47 条误判（我照着试过）。
*/
const BROWSER_OWNERS = new Set(['frontend', 'stable-workbench', ...allowed.frontend
  .filter(spec => /^@roost\/[^/]+$/.test(spec))
  .map(spec => 'packages/' + spec.slice('@roost/'.length))]);

const errors = [];

/*
  **两份写死的路径集，各自原来在文件里出现两遍。**

  `f30ffc3` 的教训是「规则依赖一个写死的路径，文件一搬规则就静默消失」，当时的对策是文件
  末尾那张锚点表。但只钉了 6 个路径里的 1 个——因为锚点表是**手抄**的第三份。三份手抄
  的东西必然漂移，这里改成一份：规则用它、锚点表也用它，想漏都漏不掉。

  同一批文件在下面出现两次是有原因的：一次是逐边检查（直接 import react），一次是可达性
  检查（经由中转到达 react）。两者必须看同一批文件，否则就是一个只挡正面的门。
*/
/*
  **library 唯一能越过自己目录的去处。**

  下面那条规则的实现比它的错误信息严得多：它禁的是「引用自己目录之外的任何相对路径」，
  而不只是 UI/workspace/terminal。那份严格是 library 能保持叶子的真正原因，所以不能因为
  一次需要就整条放宽成「可以引 shared」——那等于把 shared/store、shared/ui 一起放进来。

  改成一张点名单，**而且这张名单是可验证的**：文件末尾会检查每一项自己有没有 import。
  一个 import 都没有的模块，library 引它之后仍然是叶子——这是能证明的，不是约定。
  哪天有人往 `shared/uid.ts` 里加一行 import，这里当场红。

  `uid` 进这张单子的理由：它是 RFC 4122 v4 生成器，和「资料库」没有任何关系，却因为住在
  library 里而逼得 bookmarks、conversations 整个特性去认识资料库。
*/
const LIBRARY_LEAF_IMPORTS = ['shared/uid.ts'];

/** 状态内核：必须能脱离 React 跑。 */
const STATE_CORE_FILES = [
  'features/library/api.ts',
  'features/library/client.ts',
  'features/library/query.ts',
  'shared/store/observable.ts',
  'shared/store/state.ts',
  'features/terminal/session/sessionController.ts',
];
/** 引擎：轻量终端入口不许把它们拉进来。 */
const TERMINAL_ENGINE_FILES = [
  'features/terminal/engine/xtermEngine.ts',
  'features/terminal/useTerminal.ts',
];
/** `features/x/y.ts` → 去掉扩展名，用来和解析出来的 `to` 比。 */
const bare = file => file.replace(/\.tsx?$/, '');

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
      for (const [, spec] of source.matchAll(/(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`](\.[^"'`]*)["'`]/g)) {
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
    // 引号字符类里必须带反引号：`import(\`../../app/Shell\`)` 这种模板写法原来整条穿过
    // 所有规则。变量形态（`import(p)`）正则治不了，要 AST，暂不处理。
    const imports = source.matchAll(/(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g);
    for (const [, spec] of imports) {
      let reason;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(path), spec);
        if (!target.startsWith(base + sep)) reason = 'cross-workspace relative import';
        if (owner === 'frontend') {
          const from = relative(resolve(base, 'src'), path).split(sep).join('/');
          const to = relative(resolve(base, 'src'), target).split(sep).join('/');
          if (from.startsWith('features/library/') && !to.startsWith('features/library/')
              && !LIBRARY_LEAF_IMPORTS.some(f => to === f || to === bare(f))) reason = 'library may only import its own directory or a proven-leaf shared module';
          /*
            **共享层不许反过来依赖特性。** 一个共享模块只要引用了某个特性，它就不再是共享的
            了，而是那个特性的一部分，只是名字骗人。`store/` 同理：工作区状态是所有特性的
            下游，不能倒过来。

            这条一度只对 `shared/ui/` 生效，因为 `shared/api/conversations.ts` 曾经反过来
            引用 `features/conversations/` 里的载荷类型，全量开启会直接红。当时没有把规则
            放宽到「刚好能过」——那等于把问题藏起来；类型的归属已经修好（载荷进
            shared/api/conversationPayloads.ts），所以现在恢复成完整版。
          */
          // embeds/ 必须在这里面。少了它，`shared/ → embeds/ → features/` 就是一条洗白
          // 通道：直连被拦，中转一下就过。实测过，两行都补上之后仍然全绿。
          /*
            `(?:\/|$)` 那半不能省——**这是同一个错第二次犯**。上一次记在 featureOf 头上
            （`import x from "../session-status"` 解析成目录入口时没有尾斜杠），当时修了
            featureOf 和 pluginOf，漏了这条。

            实测：`import "../../plugins"` 解析出的 `to` 就是 `plugins`，没有斜杠，原来的
            正则匹配不上，下面两条**整条跳过**。写成 `../../plugins/index` 才会红。今天
            `plugins/index.ts` 存在，所以这条洗白通道当时是通的。
          */
          const FEATURE = /^(features|app|plugins|embeds)(?:\/|$)/;
          if (from.startsWith('shared/') && FEATURE.test(to)) reason = 'a shared layer must not depend on a feature';
          if (['shared/store/state.ts', 'shared/store/observable.ts'].includes(from) && FEATURE.test(to)) reason = 'workspace state must not depend on features';
          /*
            原来写的是 `/(?:xtermEngine|useTerminal|index)$/`——**只做结尾匹配、不限定目录**，
            于是 `public.ts` 引任何一个 `index` 结尾的模块都会被误判。实测：让它引
            `shared/store/index` 就报「light terminal entry must not load the engine」。
            今天没炸只是因为 public.ts 恰好只引自己目录下的东西。

            `index` 那一支还是死的：`features/terminal/` 下没有 index 文件。一并去掉。
          */
          if (from === 'features/terminal/public.ts' && TERMINAL_ENGINE_FILES.some(f => to === f || to === bare(f))) reason = 'light terminal entry must not load the engine';
          /*
            **特性不许反过来依赖 app/。** `app/` 是组装层：它认识所有特性并把它们拼成界面，
            所以特性一旦回头 import 它，方向就反了——那个模块实际上属于组装层而不是特性。

            环检测（frontend/tests/module-graph.test.ts）拦不住这一类：`CommandPalette`
            依赖 `app/RightPanel` 而 RightPanel 不依赖回去，构不成环，它就一路长着。
            这正是 `shared/view.ts` 那段注释讲过的故事——`Mode` 曾经长在 `Shell.tsx` 里，
            修好之后同样的形状换个名字（`RightView`）又长了一遍。所以这次补成规则。

            `main.tsx` 是例外：它是组装的起点，本来就该认识 app/。
          */
          if (/^(features|plugins|embeds)\//.test(from) && to.startsWith('app/')) reason = 'a feature must not depend on the app composition layer';
          /*
            **一个特性只要有 public.ts，别的特性就只能从那儿进。**

            这条一直是靠自觉的：`features/terminal/public.ts` 顶上写着「特性外部只准从这里
            进」，而且真的被遵守了——5 个外部消费者无一例外。但 session-status 就没这个运气，
            外面 14 处 import 直接摸进 7 个内部文件，于是它每一次内部重命名都可能碰到
            terminal、workspace、conversations 三个特性。收口之后补上这条，让纪律不再依赖
            有没有人读过那段注释。

            只管特性之间。`app/` 是组装层，它按路径引用 `view/` 下的组件是常规做法；
            特性内部各模块也直接互相 import，不必绕自己的公开入口转一道。
          */
          // `(?:\/|$)` 那半不能省：`import x from "../session-status"` 解析成目录入口时
          // `to` 没有尾斜杠，整条规则会静默跳过。同一个文件里的 pluginOf 写对了，这里
          // 原来写漏了。
          const featureOf = path => path.match(/^features\/([^/]+)(?:\/|$)/)?.[1];
          const publicOwner = featureOf(to);
          if (publicOwner && publicOwner !== featureOf(from)
              && /^(features|embeds)\//.test(from)
              && existsSync(resolve(base, 'src/features', publicOwner, 'public.ts'))
              && !/^features\/[^/]+\/public(\.ts)?$/.test(to)) {
            reason = `feature ${publicOwner} has a public entry; enter through it`;
          }
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
        const inFrontend = owner === 'frontend' && relative(resolve(root, 'frontend/src'), path).split(sep).join('/');
        if (inFrontend && STATE_CORE_FILES.includes(inFrontend) && /^react(?:-dom)?(?:\/|$)/.test(spec)) reason = 'state core must remain independent of React';
        if (node && BROWSER_OWNERS.has(owner)) reason = 'Node dependency in browser code';
        else if (spec.startsWith('@roost/') && !allowed[owner].includes(spec)) reason = 'private or disallowed package entry';
        else if (owner.startsWith('packages/') && !node && !allowed[owner].includes(spec)) reason = 'undeclared package dependency';
      }
      if (reason) errors.push(`${relative(root, path)}: ${spec}: ${reason}`);
    }
  }
}
/*
  **可达性检查。**

  上面那些规则都是逐条边判断的：「这一条 import 允许吗」。它们从不问「A 经过任意路径能
  不能到达 B」，于是任何禁令都能靠一个中转模块洗掉——实测过，`shared/reactShim.ts` 里只写
  一行 `export { useState } from "react"`，再让状态内核 import 它，每条边单独看都合法，
  而「状态内核必须能脱离 React 跑」这条约束整个作废。那个文件看起来还完全像个正当的兼容层。

  这里只对**没有例外**的两条做传递检查。其余几条（特性不许依赖 app、共享层不许依赖特性、
  公开入口）都带着有意的例外——比如 `app/` 按约定可以直接引 `view/` 下的组件——全量闭包
  会把正当写法一起判红，那不是收紧而是添乱。

  报错要带路径。一条「A 不该到达 B」而不说经过了谁，读的人只能自己再走一遍图。
*/
const frontendSrc = resolve(root, 'frontend/src');
if (existsSync(frontendSrc)) {
  const localEdges = new Map(), externalEdges = new Map();
  /*
    **节点集必须含 `.js` 一类，否则整层可达性检查能被一个文件绕过去。**

    实测：`shared/store/state.ts` → `shared/reactShim.ts` → react 会被抓住并打出完整路径；
    把中转改名成 `reactShim.js`，同样的三段路径 **exit 0，一声不吭**——它既不是图里的节点，
    也不会被解析成任何一条边的终点。逐边规则那侧也拦不住：那条只对状态内核那几个文件生效，
    一个叫 reactShim.js 的普通文件引 react 完全合法。

    `frontend/src` 今天零个 `.js` 文件，所以这个洞没被踩到；但也没有任何东西阻止它被引进来。
  */
  for (const path of allFiles(frontendSrc, /\.(?:[cm]?jsx?|tsx?)$/)) {
    const key = relative(frontendSrc, path).split(sep).join('/');
    const local = [], external = [];
    for (const [, spec] of readFileSync(path, 'utf8').matchAll(/(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)) {
      if (!spec.startsWith('.')) { external.push(spec); continue; }
      const target = resolve(dirname(path), spec);
      const swapped = target.replace(/\.(js|jsx|mjs|cjs)$/, m => ({ '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' })[m]);
      for (const base of [target, swapped]) {
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']) {
          if (existsSync(base + ext)) { local.push(relative(frontendSrc, base + ext).split(sep).join('/')); }
        }
      }
    }
    localEdges.set(key, local); externalEdges.set(key, external);
  }
  /** 从 start 出发找第一条到达「命中 hit」的路径；hit 判的是外部依赖或本地文件。 */
  const findPath = (start, hitExternal, hitLocal) => {
    const queue = [[start, [start]]], seen = new Set([start]);
    while (queue.length) {
      const [node, trail] = queue.shift();
      for (const spec of externalEdges.get(node) ?? []) if (hitExternal(spec)) return [...trail, spec];
      for (const next of localEdges.get(node) ?? []) {
        if (seen.has(next)) continue;
        if (hitLocal?.(next)) return [...trail, next];
        seen.add(next); queue.push([next, [...trail, next]]);
      }
    }
    return null;
  };
  for (const key of localEdges.keys()) {
    if (STATE_CORE_FILES.includes(key)) {
      const trail = findPath(key, spec => /^react(?:-dom)?(?:\/|$)/.test(spec));
      if (trail) errors.push(`frontend/src/${key}: state core must remain independent of React (经由 ${trail.join(' -> ')})`);
    }
    if (key === 'features/terminal/public.ts') {
      const trail = findPath(key, () => false, next => TERMINAL_ENGINE_FILES.includes(next));
      if (trail) errors.push(`frontend/src/${key}: light terminal entry must not load the engine (经由 ${trail.join(' -> ')})`);
    }
  }
}

/*
  **规则锚点。** 上面有三条规则的生效条件是「某个文件叫这个名字」——public.ts 的
  existsSync、以及轻量入口那条写死的 xtermEngine。把文件改个名、连同所有引用一起改掉，
  是一次看起来完全正常的提交，而规则会**静默地整条消失**，此后随便谁都能深引进去。

  引用存在性检查守得住「改了一半」，守不住「改得很干净」。所以这里显式钉住锚点：
  它们比规则本身更该被守着。
*/
/*
  **点名单里的每一项必须自己是叶子。** 这条把上面那个例外从「约定」变成「能证明的事」：
  library 引一个零依赖的模块之后仍然是叶子。有人往里面加 import，这里当场红，而不是让
  library 悄悄长出一条传递依赖。
*/
{
  const src = resolve(root, 'frontend/src');
  const ANY_IMPORT = /(?:\bfrom\s*|(?<![\w"'-])import\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`][^"'`]+["'`]/;
  for (const leaf of LIBRARY_LEAF_IMPORTS) {
    const file = resolve(src, leaf);
    if (!existsSync(file)) { errors.push(`${leaf}: LIBRARY_LEAF_IMPORTS 指向的文件不存在`); continue; }
    if (ANY_IMPORT.test(readFileSync(file, 'utf8'))) errors.push(`frontend/src/${leaf}: library 的例外必须自己零依赖，它现在有 import 了`);
  }
}

for (const anchor of [
  'frontend/src/features/terminal/public.ts',
  'frontend/src/features/session-status/public.ts',
  'frontend/src/features/library/public.ts',
  /*
    这两批原来只钉了 6+2 个里的 2 个，因为锚点表是手抄的第三份。现在直接从规则用的那份
    生成——规则和锚点从此不可能对不上。
  */
  ...STATE_CORE_FILES.map(f => `frontend/src/${f}`),
  ...TERMINAL_ENGINE_FILES.map(f => `frontend/src/${f}`),
]) {
  if (!existsSync(resolve(root, anchor))) errors.push(`${anchor}: 规则锚点不存在——改名或删除时请同步更新 scripts/check-boundaries.mjs`);
}

/*
  导出了，但**全仓库没有一个地方 import 它**。

  今天这一天里这条形状的缺陷出现了三次，而且全是靠用户抱怨才发现的：

    · `ConversationCatalog` —— 完整的历史对话浮层（搜索、分页、点进详情），零个 import。
      用户点遍界面找不到自己的历史记录。
    · `closeSession` —— 软关闭从 API 到 store 到 reducer 全套齐备，界面零入口。
      于是「关闭」这个概念在产品里根本不存在，只有「彻底删除」。
    · `fetchAiControl` —— 三天前加的，零调用方。

  这类东西类型检查抓不到（它们语法上完全正确）、测试也抓不到（没人测没接线的东西）、
  构建更不会响——它只是**静静地不存在**。而写代码的人以为做完了。

  **判据取最保守的一档：零个 import 才报。** 只被测试 import 的不报——那多半是为了可测
  而导出的内部件，一刀切会逼出一堆无意义的豁免，而豁免多了这条检查就废了。
  宁可漏掉一些，也不要让人习惯于往名单里加东西。
*/
const ENTRY_FILES = ['frontend/src/main.tsx', 'frontend/src/stable.tsx'];
const UNWIRED_EXEMPT = new Set([
  // 只放**有意保留、且说得出理由**的。加之前先问一句：它真的该留着吗？
]);

function checkUnwiredExports() {
  /*
    只扫前端的**值导出**（组件、函数、常量），不扫类型，也不扫各 package 的内部件。

    这不是偷懒，是让这条检查保持可用：类型和库内部件里「导出了但只在本文件用」的情况
    太多，一口气报二十几条，人只会去加豁免名单，而豁免多了这条检查就废了。
    而「做完了没接线」这个毛病的实际发生地就是前端界面——今天那三次全在这儿。
  */
  const files = [...allFiles(resolve(root, 'frontend/src'), /\.tsx?$/)];
  const used = new Set();
  const everyFile = [];
  for (const owner of [...owners, 'scripts', 'deploy']) {
    for (const file of allFiles(resolve(root, owner), /\.(tsx?|mjs|mts|jsx?)$/)) everyFile.push(file);
  }
  for (const file of everyFile) {
    const text = readFileSync(file, 'utf8');
    // 静态 import / 再导出。
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
      for (const piece of match[1].split(',')) {
        const name = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) used.add(name);
      }
    }
    for (const match of text.matchAll(/(?:^|\n)\s*import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) used.add(match[1]);
    /*
      **动态导入取属性**：`lazy(() => import("./X").then(m => ({ default: m.Foo })))`。
      名字不在任何 import 列表里，只出现在一次属性访问上。漏了这条，所有懒加载的组件
      都会被误报——我第一版就这么误报了刚接上的对话目录。
    */
    /*
      **一切属性访问都算用到。** 判据必须松：这条检查唯一的敌人是假阳性——报错一次冤枉人，
      人就会去加豁免，豁免一多它就废了。

      要盖住的至少有这几种，它们都不出现在 import 列表里：
        · `lazy(() => import("./X").then(m => ({ default: m.Foo })))`   懒加载组件
        · `import * as client from "./api"; client.fetchBookmarks()`     命名空间
        · 注入的对象上调同名方法

      代价是「名字凑巧和某处属性重名」会被放过。可以接受：这条检查只负责抓
      **一次都没被提到过**的那种，那才是「做完了忘了接线」的形状。
    */
    for (const match of text.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) used.add(match[1]);
  }
  for (const file of files) {
    const rel = file.slice(root.length + 1);
    if (ENTRY_FILES.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // 只认值：`type` / `interface` 不在内。
    for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (used.has(name) || UNWIRED_EXEMPT.has(name)) continue;
      errors.push(`${rel}: 导出了 ${name}，但全仓库没有一处用到它——接上它，或者删掉`);
    }
  }
}
checkUnwiredExports();

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Workspace source boundaries passed');
