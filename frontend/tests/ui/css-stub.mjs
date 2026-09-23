/*
  让组件能在 node 里被 import。

  前端组件会 `import` 样式文件（比如公式渲染要配的 `katex.min.css`），而 node 加载不了
  `.css`。这个解析钩子把它们指向一个空模块——测试关心的是**渲染出什么结构**，
  样式本身另有守卫（见 markdown-math.test.ts 里那条「谁用 renderMarkdown 就必须
  一起 import katex 的 CSS」）。
*/
export async function resolve(specifier, context, next) {
  if (/\.(css|scss|sass|less)(\?.*)?$/.test(specifier))
    return {url: 'data:text/javascript,export default {}', shortCircuit: true};
  return next(specifier, context);
}
