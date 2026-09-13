/// <reference types="vite/client" />

declare module "virtual:file-icons" {
  /** vscode-icons 的构建期子集，只含 file-icons.ts 里 USED_ICON_NAMES 列出的图标。 */
  export const icons: Record<string, { body: string }>;
}

/*
  ketcher-standalone 的 package.json 里，"./dist/binaryWasm" 这个 export 只声明了
  import/require，漏了 types——类型文件就在它旁边（dist/binaryWasm/index.d.ts），
  但按 exports 解析拿不到，于是整个模块退化成 any。

  我们要这个入口，是因为包根那个默认入口把 20 MB 的 indigo WASM 内联成 base64
  塞在 JS 里；binaryWasm 把 .wasm 作为独立文件发出来，能流式编译、能单独缓存。

  两个入口导出的是同一套东西，所以直接从包根借类型，而不是写一份会和上游漂移的声明。
*/
declare module 'ketcher-standalone/dist/binaryWasm' {
  export * from 'ketcher-standalone';
}
