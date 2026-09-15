/* 逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-primitives/src/markdown/katex.tsx —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。 */
/**
 * TeX-to-React via KaTeX, replicating the rehype-katex pipeline this renderer
 * replaced: the same three-arm error chain (strict render, `strict: 'ignore'`
 * retry, error span) and a DOM-identical element tree, so settled math keeps
 * its exact markup. KaTeX emits an HTML string; the browser's own HTML parser
 * (`DOMParser`, applying the spec's SVG/MathML foreign-content attribute
 * adjustments KaTeX output relies on) turns it into a tree this module maps
 * onto React elements — KaTeX output is a static span/MathML/SVG vocabulary
 * with no raw user HTML, the same trust shiki's tree gets in CodeBlock.
 *
 * React 18 has no MathML support, so the `.katex-mathml` subtree's elements
 * land in the HTML namespace — exactly as they did under the replaced
 * hast-util-to-jsx-runtime pipeline. The visual arm is the `.katex-html`
 * span tree; the MathML arm serves assistive technology, which reads it by
 * tag name regardless of namespace.
 */

import { createElement, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
// ROOST-CHANGE：上游这里是 `import katex from 'katex'`（静态）。改成按需加载 ./katex-lazy.ts，
// 理由和实测数字写在那个文件里。renderTexToReact 的签名没变，render.tsx 保持逐字。
type KatexEngine = typeof import('./katex-lazy.ts')['katex']

/**
 * Convert one inline `style` attribute string into React's style object.
 * KaTeX emits only plain kebab-case declarations (no custom properties and no
 * nameless declarations), so camel-casing the property is the whole mapping.
 */
function styleObject(css: string): CSSProperties {
  const style: Record<string, string> = {}
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const name = declaration.slice(0, colon).trim()
    const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    style[key] = declaration.slice(colon + 1).trim()
  }
  return style
}

/** Map one parsed DOM node onto a React element (text nodes pass through). */
function domToReact(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  /* v8 ignore next 2 -- KaTeX output holds only elements and text; other
     node kinds cannot appear in its serialized vocabulary. */
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const element = node as Element
  const props: Record<string, unknown> = { key }
  for (const attribute of element.attributes) {
    if (attribute.name === 'class') props['className'] = attribute.value
    else if (attribute.name === 'style') props['style'] = styleObject(attribute.value)
    else props[attribute.name] = attribute.value
  }
  const children = [...element.childNodes].map(domToReact)
  return children.length === 0
    ? createElement(element.localName, props)
    : createElement(element.localName, props, ...children)
}

/**
 * ROOST-CHANGE：上游这个函数叫 renderTexToReact 且直接用模块级的 katex。这里把引擎
 * 变成入参，函数体逐字不动；同名的导出挪到文件尾，负责在引擎到位后调它。
 * @param katex - 已加载的 KaTeX 引擎。
 * @param value - The TeX source (math node value; fenced `math` blocks append
 * their trailing newline to match the replaced pipeline's text extraction).
 * @param displayMode - Display (block) versus inline rendering.
 * @returns KaTeX's element tree, or the error span when the source does not
 * parse (colored with KaTeX's stock `errorColor`, matching rehype-katex).
 */
function renderTexWith(katex: KatexEngine, value: string, displayMode: boolean): ReactNode {
  let html: string
  try {
    html = katex.renderToString(value, { displayMode, throwOnError: true })
  } catch (error) {
    try {
      html = katex.renderToString(value, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      // KaTeX renders ParseErrors itself under throwOnError: false; only its
      // internal errors reach here, so mirror rehype-katex's manual span.
      /* v8 ignore next 8 */
      return (
        <span
          className="katex-error"
          style={{ color: '#cc0000' }}
          title={String(error)}
        >
          {value}
        </span>
      )
    }
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return [...parsed.body.childNodes].map(domToReact)
}

/*
  ROOST-CHANGE 的后半段：引擎到位之前先把 TeX 原文按字面画出来，到位之后同步渲染。

  用 useSyncExternalStore 而不是 useEffect + setState，是因为引擎是**模块级**的单例：
  第二条公式挂载时引擎多半已经在了，getSnapshot 当场就返回它，不会先闪一帧原文。
  上游在流式渲染时本来就把 TeX 留成字面量（见 render.tsx 的 `context.streaming` 分支），
  所以这个占位态和上游的中间态长一个样。
*/
let engine: KatexEngine | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  loading ??= import('./katex-lazy.ts').then(module => {
    engine = module.katex
    for (const listener of listeners) listener()
  })
  return () => { listeners.delete(onChange) }
}

function getSnapshot(): KatexEngine | null {
  return engine
}

/** 引擎未到位时的占位：TeX 原文，保留空白。 */
function TexNode({ value, displayMode }: { value: string; displayMode: boolean }): ReactNode {
  const katex = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (katex === null) {
    return <span className="katex-pending" style={{ whiteSpace: 'pre-wrap' }}>{value}</span>
  }
  return renderTexWith(katex, value, displayMode)
}

/**
 * Render TeX source to React elements through KaTeX.
 * @param value - The TeX source (math node value; fenced `math` blocks append
 * their trailing newline to match the replaced pipeline's text extraction).
 * @param displayMode - Display (block) versus inline rendering.
 * @returns KaTeX's element tree, or the error span when the source does not
 * parse (colored with KaTeX's stock `errorColor`, matching rehype-katex).
 */
export function renderTexToReact(value: string, displayMode: boolean): ReactNode {
  return <TexNode value={value} displayMode={displayMode} />
}
