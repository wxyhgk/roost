import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import type { ComponentType, ReactNode } from "react";

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

/**
 * 活在预览弹窗**之外**的编辑器。
 *
 * 有些类型没法在弹窗里编：弹窗是 `key={selected}` 的，每换一个文件就重挂一次；文件树
 * 本身也活在 `key={rightView}` 和 `key={session.id}` 之下。分子编辑器住在 iframe 里，
 * 那一销毁就是 9 MB 代码加 wasm 的完整冷启动——所以它必须挂在 `Shell` 这个唯一稳定的
 * 落点上，由文件树隔空通知它「该编辑谁」。
 *
 * 这个契约把那件事说清楚，于是文件树和 Shell 都不必认识任何具体类型：前者问注册表
 * 「这个文件归谁管」，后者照着注册表把宿主渲染一遍。
 */
export type ExternalEditorContext = {
  sessionId: string;
  /** 打开那一刻的根目录快照。 */
  root: string;
  /** 当前选中的路径。 */
  path: string | null;
  /** 这个文件归不归我管。不管时编辑器应当是关着的。 */
  active: boolean;
  /** 编辑器自己关掉了（关闭按钮、Esc），选中该跟着撤销。 */
  onClosedItself(): void;
  /** 保存成功，文件变了。 */
  onSaved(): void;
};

export type ExternalEditor = {
  match(filename: string): boolean;
  /** 出错时报给用户的区域名。Shell 不认识具体类型，标签只能由编辑器自己给。 */
  region: string;
  /** 由 Shell 渲染一次，活在整棵树的稳定落点上。 */
  Host: ComponentType;
  /** 文件树每次渲染都调用；返回有没有未保存的修改。 */
  use(context: ExternalEditorContext): { dirty: boolean };
  /** 关掉它。文件树关闭预览时会挨个调用——关一个没开着的编辑器必须是无害的。 */
  close(): void;
};

/** 这个文件归不归某个外部编辑器管。纯函数，**不是 hook**——理由见下面 close 那段。 */
export function handledExternally(editors: readonly ExternalEditor[], path: string | null): boolean {
  return !!path && editors.some(editor => editor.match(path));
}

/**
 * 全部关掉。做成模块级函数而不是 `useExternalEditor` 的返回值，是为了解开一个真实的环：
 * 调用方的 `close` 要关掉外部编辑器，而 `useExternalEditor` 的 `onClosedItself` 参数
 * 又要那个 `close`。拿返回值就晚了。
 *
 * 关一个没开着的编辑器必须是无害的——这里不挑，也不知道当前文件归谁管。
 */
export function closeExternalEditors(editors: readonly ExternalEditor[]): void {
  for (const editor of editors) editor.close();
}

/**
 * 把「该编辑谁」告诉每一个外部编辑器，并收回有没有未保存的修改。
 *
 * **在循环里调用 hook 是安全的**，因为 `editors` 是模块级常量：长度和顺序在整个进程里
 * 不变，React 要求的「每次渲染调用顺序一致」因此成立。换成运行时可变的数组就不行了。
 */
export function useExternalEditor(editors: readonly ExternalEditor[], context: Omit<ExternalEditorContext, "active">) {
  const states = editors.map(editor =>
    editor.use({ ...context, active: !!context.path && editor.match(context.path) }));
  return { dirty: states.some(state => state.dirty) };
}

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
