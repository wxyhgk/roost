/**
 * 文件预览的插件注册表。
 *
 * **「有哪些插件」这个问题只在这里有答案。** 原来它写在 `features/files/FilePreviewModal.tsx`
 * 第 13 行——一个特性文件里拼着一个数组，于是消费方同时也是注册方：谁想知道有哪些插件，
 * 得去读文件预览弹窗的源码；而加一个插件要改那个弹窗。
 *
 * 顺序就是匹配顺序：更专的排前面（.md 既是文本也是 markdown，markdown 要先匹配到）。
 */
import type { EditorPlugin } from "../shared/editor";
import { imagePlugin, pdfPlugin } from "./media";
import { markdownPlugin } from "./markdown";
import { xyzPlugin } from "./xyz";
import { codePlugins } from "./code";

export const EDITOR_PLUGINS: readonly EditorPlugin[] = [
  imagePlugin,
  pdfPlugin,
  xyzPlugin,
  markdownPlugin,
  ...codePlugins,
];

