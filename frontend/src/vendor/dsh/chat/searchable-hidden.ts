/*
  逐字抄自 deepseek-harness（MIT，`packages/client/ui-chat/src/client/chat/searchable-hidden.ts`，
  提交 0d1f500）。ROOST-CHANGE：返回类型 `RefObject<HTMLDivElement>` → `RefObject<HTMLDivElement | null>`
  ——React 19 的 useRef(null) 带上了 null，上游按 @types/react 18 写的。

  它干的事：折叠内容用 `hidden="until-found"` 而不是不渲染，于是**浏览器 Cmd+F 仍然能搜到，
  命中时自动展开**（靠 beforematch 事件）。我们现在的折叠是条件渲染，搜不到。
*/
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Apply searchable hidden state without unmounting a stable subtree.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's `beforematch` reveal.
 * @returns ref for the stable subtree root.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    if (hidden) element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
  }, [hidden, reveal])
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [reveal])
  return ref
}
