/*
  抄自 deepseek-harness（MIT，`packages/client/ui-tool/src/client/tool/models/image-card-model.ts`，
  提交 0d1f500）。

  ROOST-CHANGE 两处：

  1. **`imageCardModel()` 没搬**（上游 11 KB，大半在认他们持久化的附件引用
     `ImageAttachmentRef` 和 `presentationMeta.path`）。我们没有附件管线。
  2. **`images` 字段换成一个 `ReactNode`。** 上游把画廊交给 `tool.call.images` slot——
     由拥有这一行的 toolview 连同「会话授权过的图片 loader」一起递进来，好让工具层永远
     不碰附件实现，也不碰 URL 授权。我们没有 slot 运行时，所以直接收一个已经画好的节点。

  **渲染路径留着，不传就不画**——照 `chat/MessageIconActions.tsx` 的 `onBranch` 那条先例：
  删掉那段渲染就等于改了上游的结构，将来重新同步要做三方合并；留着的代价只是几行死代码。
  等我们真有了附件管线，传个节点进来它就自己出现了。

  注意标签行那条 `font: var(--dsw-font-sm-13)`：**这个令牌上游自己也没定义**
  （在他们 ui-theme 里 grep 不到），我们在 tokens.css 里补了一个值并标了 `[猜]`。
*/
import type { ReactNode } from 'react'

/** Validated image-card material for a call whose result is an image. */
export interface ImageCardModel {
  /** Card label: the read path, shortened the way every other card's is. */
  label: string
  /**
   * 画廊本体。ROOST-CHANGE：上游是
   * `readonly { readonly attachment: ImageAttachmentRef }[]`，经 slot 渲染。
   * 不传 = 只画标签和下面那行 envelope 文本。
   */
  gallery?: ReactNode
  /**
   * The model-facing envelope text, for the line under the gallery.
   *
   * Taken from the result's own text block rather than the row's flattened
   * result text: an image read's content is `[text envelope, image block]`, and
   * flattening JSON.stringifies the image block, which would print the raw
   * attachment object under the picture — the symptom this card exists to remove.
   */
  text: string
}
