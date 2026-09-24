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

  `api/session-fetch` 的理由：401 广播和兜底截止时间是**必须对每一个请求都成立**的两件事，
  而 library 有自己的错误类型、用不了 `request<T>`。它原来用裸 `fetch`，于是会话过期时
  笔记和命令面板的 401 不触发登录关卡、请求挂住也没有截止时间。第一版让它引 `request.ts`，
  被这条规则当场拦下——拦得对，那个文件引着 i18n 和 errors。
*/
const LIBRARY_LEAF_IMPORTS = ['shared/uid.ts', 'shared/api/session-fetch.ts'];

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

/*
  动态 `import()` 不许用模板字符串拼**裸包名**。

  实测撞到的形状：`await import(\`shiki/dist/langs/${lang}\`)`。它在 node 里跑得通，
  所以单元测试一路绿；但打包器分析不了模板字符串里的裸包名（相对路径它还能 glob，
  裸包名不行），产物里原样留下一个裸规范符，浏览器解析不了 → promise reject →
  被调用处的 try/catch 吞掉。

  后果是**代码高亮在生产环境从来没工作过，而 165 KB 的依赖照常下载**——不报错、
  不失败、就是不工作。dist 里一个语言分片都没有是唯一能看出来的痕迹，而没人会去看。

  相对路径的模板字符串放行：那个打包器认得，会把匹配到的文件都切成分片。
*/
function checkDynamicImportSpecifiers() {
  for (const owner of owners) {
    for (const file of allFiles(resolve(root, owner, 'src'), /\.(tsx?|mts)$/)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bimport\(\s*`([^`]*)`/g)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        errors.push(`${file.slice(root.length + 1)}: 动态 import 用模板字符串拼了裸包名 \`${specifier}\`` +
          `——打包器分析不了，产物里会留下浏览器解析不了的规范符，而且失败是静默的。改成一张显式的映射表`);
      }
    }
  }
}
checkDynamicImportSpecifiers();

/*
  **有一个语义令牌，而某处用了绕开它的写法。**

  这个形状一天之内撞到三次，每一次都是「改了 token，用它的人根本不读它，而且不报错」：

    · 给 `--shadow-modal` 加了一圈 0.5px 的描边，而 SettingsDialog / BookmarksDialog /
      MoleculeModal 用的是 Tailwind 默认的 `shadow-2xl`——压根不读那个变量，于是那圈描边
      永远到不了它们身上。
    · 同一件事的另一份藏在 CSS 里：`features/subscriptions/subscriptions.css` 写死了
      `box-shadow: 0 8px 32px #0003`，绕过 `--shadow-pop`。按 className 搜的那一轮扫不到它，
      因为它根本不是 className——**所以这条检查必须同时看 .tsx、.ts 和 .css**。
    · `.subscription-meter` 拿 `--color-border` 当**实心填充**，而那个 token 后来被改成半透明
      的分隔线色，槽和进度的对比度就没了。

  前两条是「读的不是那个变量」，形状固定、正则抓得住。**第三条抓不住**：它读的就是正确的
  token，只是语义选错了（分隔线色 ≠ 填充色）。这里不假装能管第三条——能管的写清楚，管不了的
  说明白，比装作全覆盖强。

  只对 `frontend/src` 生效：这套令牌就定义在 `frontend/src/styles/tokens.css`，
  stable-workbench 既不用 Tailwind 也没有这套变量，把它拉进来只会凭空制造要豁免的东西。
*/
/*
  **动手之前必须先把注释挖掉，这是这条检查能不能活下来的前提。**

  实测：今天全仓库 `text-xs`(4 处)、`text-sm`(4 处)、`shadow-2xl`(1 处) 的**全部**命中
  都在注释里，而且正是**记录这几次事故的那几段注释本身**——tokens.css 里「text-xs/text-sm
  现在是 0 处」那段、subscriptions.css 里「阴影原来是写死的，绕过了 --shadow-pop」那段。

  不挖注释，这条检查上线第一天就红在「解释它为什么存在」的文字上，然后被人加豁免加到废掉。

  行号要留住（注释换成等量空白而不是删掉），否则报错指的行是错的，比不报还难查。
*/
/** 把注释换成等量空白。`line` 关掉时不处理 `//`——CSS 没有行注释，而 url(http://…) 会被误伤。 */
export function blankComments(text, { line = true } = {}) {
  const blank = s => s.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  // 前一个字符不许是 `:`，否则 `https://x` 的后半段会被当成行注释吃掉（那是假阴性，更难发现）。
  if (line) out = out.replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, lead) => lead + blank(m.slice(lead.length)));
  return out;
}

/*
  颜色字面量归一成 `r,g,b,a`。

  比字符串是不够的：`#fff` / `#ffffff` / `rgb(255,255,255)` 是同一个颜色的三种写法，
  而 `rgba(255,255,255,0.10)` 和 `rgba(255, 255, 255, .1)` 也是。两边都过同一个函数，
  才不会「值一样但写法不同」就漏掉。百分比形态（`rgb(100% 0% 0%)`）直接判不认识——
  与其猜错，不如漏掉。
*/
export function canonicalColor(literal) {
  const s = String(literal).trim().toLowerCase().replace(/\s+/g, '');
  const hex = s.match(/^#([0-9a-f]+)$/);
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].replace(/./g, c => c + c) : hex[1];
    if (digits.length !== 6 && digits.length !== 8) return null;
    const at = i => parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return [at(0), at(1), at(2), digits.length === 8 ? at(3) / 255 : 1].join(',');
  }
  const fn = s.match(/^rgba?\(([^()]*)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(',');
  if (parts.length < 3 || parts.length > 4 || parts.some(p => p === '' || p.endsWith('%'))) return null;
  const nums = parts.map(Number);
  if (nums.some(Number.isNaN)) return null;
  return [nums[0], nums[1], nums[2], parts.length === 4 ? nums[3] : 1].join(',');
}

/** tokens.css 里的 `--color-*` → 归一化值到名字的反查表。一个值可能有多个名字，都列出来。 */
export function designTokenColors(tokensCss) {
  const byValue = new Map();
  for (const [, name, raw] of blankComments(tokensCss, { line: false }).matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
    const key = canonicalColor(raw);
    if (!key) continue;
    if (!byValue.has(key)) byValue.set(key, new Set());
    byValue.get(key).add(name);
  }
  return byValue;
}

/** 按顶层逗号切 `box-shadow` 的各层：`rgba(0,0,0,.3)` 里的逗号不算。 */
function shadowLayers(value) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

/*
  纯逻辑：给一个相对路径和**原始**文件内容，返回 `{ line, message }`。不读盘、不看仓库状态。

  四条判据，以及每一条为什么长这样：

  **一、Tailwind 默认阴影档（shadow-sm/md/lg/xl/2xl/inner）一律不许。** 仓库有 `shadow-pop`
  和 `shadow-modal` 两个语义 token，它们带着那圈 0.5px 的 rim 描边；用默认档就是明说
  「我不读主题」。判据宽到整个 frontend/src 是有意的：出事的那一处（fileLinkProvider.ts）
  就在 `.ts` 里拼 className，只扫 `.tsx` 等于把当初漏掉它的那个盲区原样保留下来。

  **二、CSS 里 `box-shadow` 的某一层既不是 `var(--shadow-*)` 也不是 inset。** 不能简单地
  禁掉字面 `box-shadow`——`utilities.css` 里 `.raised` / `.glass` / `.row-rest` 三处写的是
  `inset 0 0 0 .7px var(--color-rim)` 这类**内描边环**，tokens.css 讲得很清楚：那是「这块面
  浮起来了」的高光，**不是投影**，和 `--shadow-pop` 不是一回事，并进去就是误报。
  同理 `shadow-[inset_…]` 那条顶部高光也按 inset 放行。
  分界线因此不是「有没有写 box-shadow」，而是「**这一层是不是一道投影**」。

  **三、Tailwind 默认字号档（text-xs / text-sm / text-base）一律不许。** 和前两条不同，这条
  现在是**零命中的防回潮**：那 109 处 12/14/16px 已经并回 `--text-caption` / `--text-body` /
  `--text-title` 三档，tokens.css 写着「新代码只在这三个令牌里挑」——而一句注释拦不住下一个人。
  只收 xs/sm/base 三档，**不收 lg/xl/2xl/3xl**：tokens.css 逐条写明仪表数字是另一根轴。
  小于 caption 的 9/10px 角标和代码块的 12.5px 是任意值形态（`text-[9px]`），同样够不着这条。
  这两类刻意在体系外的用法**是结构上不在判据里，不是靠豁免名单躲开的**——差别很大：
  豁免名单会被一条条加长直到检查作废，而结构外的东西永远不会来敲门。

  **四、字面颜色的值恰好等于某个 `--color-*` token 的值。** 四条里信噪比最难调的一条，
  实跑之后收窄了三处，每一处都对应一类真实的误报：

    · **跳过自定义属性声明**（`--x: #111113`）。`styles/terminal.css` 的 16 色 ANSI 调色板、
      `features/server-monitor/monitor.css` 的一套局部配色，都是在**定义**另一根轴上的
      token，字面值本来就该出现在那儿。不跳过，这两个文件一口气报 11 条，全是冤枉。
    · **跳过纯黑纯白和全透明。** `shared/chemistry/elements.ts` 里氢是 `#ffffff`（CPK 标准
      色，和主题没有半点关系），`plugins/xyz/xyz.tsx` 里 `#000000` 是**读不到 CSS 变量时的
      兜底**——它恰恰是在读 token。黑白不携带主题身份，放进来只会淹掉真正的信号。
    · **只认 `--color-*`。** `--surface-raised` 是渐变、`--shadow-*` 是阴影，都不是单色。

  收窄之后这条今天是 0 命中，但它守的是真东西：谁哪天写下 `#0a84ff` 而不是
  `var(--color-accent)`，当场红。
*/
export function styleTokenBypasses(rel, source, tokenColors = new Map()) {
  const found = [];
  const isCss = rel.endsWith('.css');
  const text = blankComments(source, { line: !isCss });
  const lineOf = index => text.slice(0, index).split('\n').length;
  const add = (index, message) => found.push({ line: lineOf(index), message });

  for (const m of text.matchAll(/\bshadow-(2xl|xl|lg|md|sm|inner)\b/g))
    add(m.index, `用了 Tailwind 默认阴影 \`shadow-${m[1]}\`——它不读 \`--shadow-pop\` / \`--shadow-modal\`，`
      + `主题给浮层加的那圈描边到不了这里。改用 shadow-pop（小浮层）或 shadow-modal（对话框）`);
  for (const m of text.matchAll(/\bshadow-\[([^\]]*)\]/g))
    if (!/^inset[_\s]/.test(m[1]))
      add(m.index, `用了任意值阴影 \`shadow-[${m[1]}]\`——投影只走 \`--shadow-pop\` / \`--shadow-modal\`；`
        + `内描边高光（inset）不在此列，那不是投影`);
  for (const m of text.matchAll(/\btext-(xs|sm|base)\b/g))
    add(m.index, `用了 Tailwind 默认字号 \`text-${m[1]}\`——字号只在 text-caption(11) / text-body(13) / `
      + `text-title(15) 三档里挑，差 1px 不携带任何含义（这 109 处已经并过一次了，别再长回来）`);
  if (isCss) {
    for (const m of text.matchAll(/box-shadow\s*:\s*([^;}]+)/g)) {
      for (const layer of shadowLayers(m[1])) {
        if (/^inset\b/.test(layer) || /^var\(\s*--shadow-/.test(layer)) continue;
        if (/^(none|unset|inherit|initial|revert)$/.test(layer)) continue;
        add(m.index, `box-shadow 里写死了一层投影 \`${layer}\`——绕过 \`--shadow-pop\` / \`--shadow-modal\`，`
          + `改主题时改不到它。内描边（inset …）不受这条管`);
      }
    }
  }
  // 自定义属性声明是**定义** token 的地方，字面值本来就该在那儿；挖掉再找字面颜色。
  const values = text.replace(/--[\w-]+\s*:\s*[^;\n]*/g, s => s.replace(/[^\n]/g, ' '));
  for (const m of values.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([0-9.,\s]*\)/g)) {
    const key = canonicalColor(m[0]);
    if (!key || !tokenColors.has(key)) continue;
    const [r, g, b, a] = key.split(',').map(Number);
    if (a === 0 || (r === g && g === b && (r === 0 || r === 255))) continue;
    add(m.index, `字面颜色 \`${m[0]}\` 的值就是 ${[...tokenColors.get(key)].sort().join(' / ')} ——`
      + `写死它等于把这个 token 的另一半留在原地，换主题时只有一半会动。改成 var(…)`);
  }
  return found;
}

function checkStyleTokenBypass() {
  const src = resolve(root, 'frontend/src');
  if (!existsSync(src)) return;
  /*
    **锚点：令牌的真源必须在，而且必须还叫这几个名字。**

    这条检查的判据全部挂在 `styles/tokens.css` 上——文件一搬，`tokenColors` 就是个空表，
    第三条判据**静默失效**；token 一改名，前两条的报错信息就在指一个不存在的东西。
    这正是这个文件顶上那段「规则锚点」讲的事，所以照样钉住。
  */
  const tokensFile = resolve(src, 'styles/tokens.css');
  if (!existsSync(tokensFile)) {
    errors.push('frontend/src/styles/tokens.css: 设计令牌的真源不存在——搬走或改名时请同步更新 scripts/check-boundaries.mjs');
    return;
  }
  const tokensCss = readFileSync(tokensFile, 'utf8');
  for (const token of ['--shadow-pop', '--shadow-modal'])
    if (!new RegExp(`${token}\\s*:`).test(tokensCss))
      errors.push(`frontend/src/styles/tokens.css: 语义令牌 ${token} 不见了——改名时请同步更新 scripts/check-boundaries.mjs 的报错信息`);
  const tokenColors = designTokenColors(tokensCss);
  // 空表意味着解析方式和 tokens.css 的写法对不上了，而那会让第三条判据一声不吭地失效。
  if (tokenColors.size < 10) errors.push(`frontend/src/styles/tokens.css: 只解析出 ${tokenColors.size} 个 --color-* 令牌，解析方式多半已经和文件写法对不上了`);
  for (const file of allFiles(src, /\.(tsx?|css)$/)) {
    if (file === tokensFile) continue; // 真源自己就是定义处。
    const rel = relative(root, file).split(sep).join('/');
    for (const { line, message } of styleTokenBypasses(rel, readFileSync(file, 'utf8'), tokenColors))
      errors.push(`${rel}:${line}: ${message}`);
  }
}
checkStyleTokenBypass();

/*
  **被 import 时不许自己跑。** 上面几个纯函数配了测试（deploy/tests/style-token-bypass.test.mjs），
  而测试一 import 这个文件，整套检查就会跟着跑一遍并把 `process.exitCode` 设成 1——
  于是测试全过、进程仍然红。所以只有当它是被直接执行的那个文件时才汇报。
*/
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Workspace source boundaries passed');
}
