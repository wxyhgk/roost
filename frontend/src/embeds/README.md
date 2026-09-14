# embeds/

**跑在 iframe 里、有自己构建入口的子应用。**

这里的东西和 `features/` 不是一类:`features/` 是这个应用的一部分,共享同一份 React
树和同一个 bundle;`embeds/` 里每一个都是**独立的一份 JS realm**,由根目录下自己的
html 入口引导,和主应用之间只有 postMessage。

## 为什么要隔离

分子编辑器是第一个住进来的,原因很具体:

- **体积。** Ketcher 那一坨是 9 MB 代码加 wasm。放进主 bundle 会把首屏拖垮,而它是
  绝大多数会话里根本不会打开的东西。
- **全局污染。** 它的依赖要 `process.nextTick`,得往 `globalThis` 上塞一个浏览器版的
  `process`(见 `molecule/bootstrap.ts`)。那种改动**不能落在终端工作台所在的 realm 里**。
- **崩了不该连累别人。** iframe 里抛异常,外面的终端照跑。

以后要放进来的东西,按这三条对一下再决定——只是「一个比较大的组件」的话,`features/`
加懒加载就够了,不必付 iframe 的代价。

## 一个 embed 的组成

以 `molecule/` 为例,三部分要分清:

| 文件 | 侧 |
| --- | --- |
| `bootstrap.ts` `frame.tsx` `frame.css` | **iframe 内**。`frontend/molecule.html` 指向 bootstrap |
| `bridge.ts` | **两侧共用**的 postMessage 协议。注意它不许 import 编辑器本身,否则宿主也会被拖进那 9 MB |
| `MoleculeModal.tsx` `editorTarget.ts` `handoff.ts` `sdf.ts` | **宿主侧**:挂 iframe、存「在编辑谁」、把结果送回终端 |

## 新增一个 embed 要动的地方

1. `frontend/<name>.html` —— 新的入口,`src` 指向 `src/embeds/<name>/bootstrap.ts`
2. `frontend/vite.config.ts` 的 `rollupOptions.input` —— 加一项
3. `stable-workbench/build.mjs` 的 `input` —— 同样加一项,否则降级版里没有它
4. `src/plugins/` 下的适配层 —— 主应用**不直接 import 这里的任何东西**,一律经由插件
   注册表。`Shell` 和 `features/files` 都不认识具体类型,理由见
   `shared/editor` 里的 `ExternalEditor`

第 4 条是硬要求,`scripts/check-boundaries.mjs` 会拦。
