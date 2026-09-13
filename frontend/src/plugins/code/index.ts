/**
 * 按语言的编辑器插件。
 *
 * **从宿主里搬出来的。** 它们原本和 `EditorPlugin` 契约、`createEditor` 挤在同一个文件里，
 * 于是「契约」和「契约的一个实现」长在一起——宿主 import 了 codemirror 的每一种语言，
 * 而新增一门语言要去改宿主。这里只有实现，宿主只认契约。
 */
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import type { EditorPlugin } from "../../shared/editor";

const tsPlugin: EditorPlugin = {
  match: (f) => /\.(ts|tsx|mts|cts)$/i.test(f),
  language: "TypeScript",
  extensions: () => [javascript({ typescript: true })],
};

const jsPlugin: EditorPlugin = {
  match: (f) => /\.(js|jsx|mjs|cjs)$/i.test(f),
  language: "JavaScript",
  extensions: () => [javascript()],
};

const jsonPlugin: EditorPlugin = {
  match: (f) => /\.(json|jsonc)$/i.test(f),
  language: "JSON",
  extensions: () => [json()],
};

const pyPlugin: EditorPlugin = {
  match: (f) => /\.(py|pyi)$/i.test(f),
  language: "Python",
  extensions: () => [python()],
};

const htmlPlugin: EditorPlugin = {
  match: (f) => /\.(html|htm)$/i.test(f),
  language: "HTML",
  extensions: () => [html()],
};

const cssPlugin: EditorPlugin = {
  match: (f) => /\.(css|scss|less)$/i.test(f),
  language: "CSS",
  extensions: () => [css()],
};

export const codePlugins: EditorPlugin[] = [
  tsPlugin,
  jsPlugin,
  jsonPlugin,
  pyPlugin,
  htmlPlugin,
  cssPlugin,
];

