import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import type { ReactNode } from "react";

export type PreviewFile = {
  name: string;
  root: string;
  path: string;
};

export type EditorPlugin = {
  match(filename: string): boolean;
  language?: string;
  extensions?: () => Extension[];
  // Binary files arrive with empty content; plugins that need the original
  // bytes (images, PDFs) use `file` to build a raw URL instead.
  preview?: (content: string, file?: PreviewFile) => ReactNode;
};

export type EditorHandle = {
  view: EditorView;
  setContent(content: string): void;
  getContent(): string;
  dispose(): void;
};

/*
  插件表是**传进来的**，没有默认值。

  宿主一旦有个默认表，它就得知道有哪些插件，于是「谁在扩展谁」的方向就反了：
  加一个插件要改宿主。现在宿主只认契约，「有哪些插件」这个问题的唯一答案在 plugins/index.ts。
*/
export function matchPlugin(
  filename: string,
  plugins: readonly EditorPlugin[],
): EditorPlugin | null {
  for (const p of plugins) {
    if (p.match(filename)) return p;
  }
  return null;
}

function monochromeTheme(): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.keyword, color: "var(--color-text)", fontWeight: "600" },
    { tag: tags.string, color: "var(--color-text)" },
    { tag: tags.comment, color: "var(--color-text-dim)", fontStyle: "italic" },
    { tag: tags.number, color: "var(--color-text)" },
    { tag: tags.bool, color: "var(--color-text)" },
    { tag: tags.null, color: "var(--color-text-dim)" },
    { tag: tags.function(tags.variableName), color: "var(--color-text)" },
    { tag: tags.variableName, color: "var(--color-text)" },
    { tag: tags.propertyName, color: "var(--color-text)" },
    { tag: tags.typeName, color: "var(--color-text)" },
    { tag: tags.operator, color: "var(--color-text-dim)" },
    { tag: tags.punctuation, color: "var(--color-text-dim)" },
    { tag: tags.meta, color: "var(--color-text-dim)" },
    { tag: tags.regexp, color: "var(--color-text)" },
  ]);
}

function editorTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "13px",
      fontFamily: "var(--font-mono)",
      lineHeight: "1.55",
    },
    ".cm-scroller": {
      height: "100%",
      fontFamily: "var(--font-mono)",
      lineHeight: "1.55",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--color-text-dim)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--color-bg-hover)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "var(--color-bg-active)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--color-accent)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "var(--color-bg-active)",
    },
  });
}

export function createEditor(
  host: HTMLElement,
  content: string,
  filename: string,
  onChange?: () => void,
  plugins: readonly EditorPlugin[] = [],
): EditorHandle {
  const plugin = matchPlugin(filename, plugins);
  const langExt = plugin?.extensions ? plugin.extensions() : [];

  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      EditorView.lineWrapping,
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(monochromeTheme()),
      editorTheme(),
      ...langExt,
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange?.();
      }),
    ],
  });

  const view = new EditorView({ state, parent: host });
  view.focus();

  return {
    view,
    setContent(next: string) {
      if (view.state.doc.toString() === next) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    getContent(): string {
      return view.state.doc.toString();
    },
    dispose() {
      view.destroy();
    },
  };
}
