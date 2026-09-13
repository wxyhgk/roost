import { lazy, Suspense } from "react";
import { t } from "@roost/i18n";
import type { EditorPlugin } from "../../shared/editor";
const Preview = lazy(() => import("./xyz").then(({ xyzPlugin }) => ({ default: ({ content }: { content: string }) => <>{xyzPlugin.preview?.(content)}</> })));
export const xyzPlugin: EditorPlugin = {
  match: filename => /\.xyz$/i.test(filename),
  language: "XYZ",
  extensions: () => [],
  preview: content => <Suspense fallback={<div className="p-3 text-text-dim">{t.misc.xyz.loading}</div>}><Preview content={content} /></Suspense>,
};
